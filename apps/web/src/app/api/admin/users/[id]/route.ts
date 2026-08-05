// BFF handler: PUT /api/admin/users/[id] — Admin 升级/降级 + 启用/禁用。
//
// 范围 (P1-A3):
//   - 修改 role (admin/member)
//   - 修改 disabledAt（禁用/恢复）
//   - 防止：最后一个 active admin 被降级或禁用
//   - 所有操作落 admin_actions（审计日志）
//
// 设计要点：
//   - 单事务；role 与 disabled 一起更新，最后 active admin 检查在事务内
//     再读一次 active admin 数量，避免并发降级到 0。
//   - 自降级/自禁用：actor 改自己时也走这条路径；防"自杀"由
//     last-active-admin 检查统一处理。
import { NextResponse } from 'next/server';
import { z } from 'zod';
import type { NextRequest } from 'next/server';
import { Prisma } from '@prisma/client';
import { ERROR_CODES } from '@deep-research/shared/errors';

import { prisma } from '../../../../../lib/db';
import { apiHandler } from '../../../../../lib/api-handler';
import { requireAdmin } from '../../../../../lib/auth/session';
import { toApiErrorResponse } from '../../../../../lib/errors';
import { withRequestId } from '../../../../../lib/log';

const bodySchema = z
  .object({
    role: z.enum(['admin', 'member']).optional(),
    disabled: z.boolean().optional(),
  })
  .strict()
  .refine((v) => v.role !== undefined || v.disabled !== undefined, {
    message: 'role 或 disabled 至少需要一项',
  });

type Action = 'role_change' | 'disable' | 'enable';

function deriveAction(input: { role?: 'admin' | 'member'; disabled?: boolean }, prev: { role: 'admin' | 'member'; disabledAt: Date | null }): Action | null {
  const wantDisabled = input.disabled ?? !!prev.disabledAt;
  if (input.disabled !== undefined) {
    if (input.disabled === false && prev.disabledAt) return 'enable';
    if (input.disabled === true && !prev.disabledAt) return 'disable';
  }
  if (input.role !== undefined && input.role !== prev.role) {
    return input.role === 'admin' ? 'role_change' : 'role_change';
  }
  if (wantDisabled !== !!prev.disabledAt) {
    return wantDisabled ? 'disable' : 'enable';
  }
  return null;
}

export const PUT = apiHandler<[NextRequest, { params: Promise<{ id: string }> }]>(async (req, ctx) => {
  const actor = await requireAdmin(req);
  if (actor instanceof NextResponse) return actor;
  const requestId = withRequestId(req.headers);

  let body: z.infer<typeof bodySchema>;
  try {
    body = bodySchema.parse(await req.json());
  } catch (err) {
    return toApiErrorResponse({
      code: ERROR_CODES.VALIDATION_FAILED,
      message: err instanceof Error ? err.message : '请求体非法',
      requestId,
    });
  }

  const { id: targetId } = await ctx.params;
  if (!targetId || !/^[0-9a-f-]{36}$/i.test(targetId)) {
    return toApiErrorResponse({
      code: ERROR_CODES.VALIDATION_FAILED,
      message: 'id 必须为 UUID',
      requestId,
    });
  }

  const updated = await prisma.$transaction(async (tx) => {
    const target = await tx.user.findUnique({
      where: { id: targetId },
      select: { id: true, role: true, disabledAt: true, email: true, name: true },
    });
    if (!target) {
      throw new NotFoundError('用户不存在');
    }

    const action = deriveAction(body, target);
    if (action === null) {
      return { target, noop: true as const };
    }

    const wantRole = body.role ?? target.role;
    const wantDisabled =
      body.disabled === undefined ? !!target.disabledAt : body.disabled;

    // 最后一个 active admin 保护：在写之前统计 active admin 数。
    const wouldRemoveAdmin = target.role === 'admin' && (
      wantRole !== 'admin' || wantDisabled === true
    );
    if (wouldRemoveAdmin) {
      const activeAdmins = await tx.user.count({
        where: { role: 'admin', disabledAt: null },
      });
      if (activeAdmins <= 1) {
        throw new LastAdminError('系统至少需要保留 1 个 active admin');
      }
    }

    // 自操作：禁止 actor 把自己降级 / 禁用（由 last-admin 兜底，但这里也
    // 给更明确的反馈，避免 "self-edit" 走到事务里才发现）。
    if (target.id === actor.id) {
      if (wantRole !== 'admin') {
        throw new SelfEditError('不能修改自己的 admin 角色');
      }
      if (wantDisabled === true) {
        throw new SelfEditError('不能禁用自己');
      }
    }

    const next = await tx.user.update({
      where: { id: target.id },
      data: {
        role: wantRole,
        disabledAt: wantDisabled ? new Date() : null,
      },
      select: { id: true, role: true, disabledAt: true, email: true, name: true },
    });

    await tx.adminAction.create({
      data: {
        actorId: actor.id,
        action: `user.${action}`,
        targetType: 'user',
        targetId: next.id,
        requestId: crypto.randomUUID(),
        metadata: {
          before: { role: target.role, disabled: !!target.disabledAt },
          after: { role: next.role, disabled: !!next.disabledAt },
        } as Prisma.JsonObject,
      },
    });

    return { target: next, noop: false as const, action };
  }).catch((err: unknown) => {
    if (err instanceof NotFoundError) {
      return { __error: { code: ERROR_CODES.NOT_FOUND, message: err.message } } as const;
    }
    if (err instanceof LastAdminError) {
      return { __error: { code: ERROR_CODES.ADMIN_NOT_ENOUGH_ADMINS, message: err.message } } as const;
    }
    if (err instanceof SelfEditError) {
      return { __error: { code: ERROR_CODES.PERMISSION_DENIED, message: err.message } } as const;
    }
    throw err;
  });

  if ('__error' in updated) {
    return toApiErrorResponse({ code: updated.__error.code, message: updated.__error.message, requestId });
  }
  if (updated.noop) {
    return NextResponse.json({ ok: true, noop: true, user: serialize(updated.target) });
  }
  return NextResponse.json({ ok: true, action: updated.action, user: serialize(updated.target) });
});

class NotFoundError extends Error {}
class LastAdminError extends Error {}
class SelfEditError extends Error {}

function serialize(u: { id: string; email: string; name: string | null; role: 'admin' | 'member'; disabledAt: Date | null }) {
  return {
    id: u.id,
    email: u.email,
    name: u.name ?? '',
    role: u.role,
    disabledAt: u.disabledAt?.toISOString() ?? null,
  };
}
