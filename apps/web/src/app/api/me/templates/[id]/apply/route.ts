// BFF handler: POST /api/me/templates/[id]/apply — 模板套用到 Research 草稿。
//
// 复制模板字段到一条新 Research（status=draft, type=research, author=当前用户），
// 并把模板 useCount + lastUsedAt 推进。返回新 Research 的 id。
import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';

import { apiHandler } from '@/lib/api-handler';
import { prisma } from '@/lib/db';
import { requireUser } from '@/lib/auth/session';
import { toApiErrorResponse } from '@/lib/errors';
import { withRequestId } from '@/lib/log';
import { ERROR_CODES } from '@deep-research/shared/errors';

export const POST = apiHandler<[NextRequest, { params: Promise<{ id: string }> }]>(async (req, ctx) => {
  const user = await requireUser(req);
  if (user instanceof NextResponse) return user;
  const requestId = withRequestId(req.headers);
  const { id } = await ctx.params;
  if (!id || !/^[0-9a-f-]{36}$/i.test(id)) {
    return toApiErrorResponse({ code: ERROR_CODES.VALIDATION_FAILED, message: 'id 必须为 UUID', requestId });
  }

  const tpl = await prisma.researchTemplate.findUnique({ where: { id } });
  if (!tpl) {
    return toApiErrorResponse({ code: ERROR_CODES.NOT_FOUND, message: '模板不存在', requestId });
  }
  if (tpl.ownerId !== user.id) {
    return toApiErrorResponse({ code: ERROR_CODES.PERMISSION_DENIED, message: '只能使用自己的模板', requestId });
  }

  const result = await prisma.$transaction(async (tx) => {
    const draft = await tx.research.create({
      data: {
        type: 'research',
        status: 'draft',
        // `title` names the reusable template in the library; `topic` is the
        // actual research question the user expects to edit after applying it.
        title: tpl.topic,
        body: '',
        background: tpl.background,
        authorId: user.id,
        aiAssisted: false,
        creationMethod: 'manual',
        tags: tpl.tags,
      },
      select: { id: true, title: true },
    });
    await tx.researchTemplate.update({
      where: { id: tpl.id },
      data: { useCount: { increment: 1 }, lastUsedAt: new Date() },
    });
    return draft;
  });

  return NextResponse.json({ ok: true, draft: result, requestId }, { status: 201 });
});
