// BFF handler: POST /api/admin/radar/[id]/create-research — Admin 从雷达候选预填生成调研草稿。
//
// 契约源：
//   - docs/agent-prompts/week5-engineer-a.md §任务 3
//   - apps/web/prisma/schema.prisma: Research + ResearchSource + AdminAction
//
// 行为：requireAdmin → 校验 summary → 在 $transaction 内创建 research(draft,
// creationMethod='ai_research', sourceRefs 包含 summary.url) + 写 admin_action。
// ai-engine 端异步接手做完整调研；本 endpoint 仅做预填。

import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { createHash } from 'node:crypto';
import { prisma } from '../../../../../../lib/db';
import { apiHandler } from '../../../../../../lib/api-handler';
import { requireAdmin } from '../../../../../../lib/auth/session';
import { toApiErrorResponse } from '../../../../../../lib/errors';
import { log, withRequestId } from '../../../../../../lib/log';
import { RadarIdParam } from '../../../../../../lib/schemas';
import {
  ADMIN_RADAR_ACTIONS,
  ADMIN_TARGET_TYPE,
  newAdminActionRequestId,
  writeAdminAction,
} from '../../../../../../lib/radar/admin-actions';
import { ERROR_CODES } from '@deep-research/shared/errors';
import { CREATION_METHOD, RESEARCH_STATUS, RESEARCH_TYPE } from '@deep-research/shared/states';

export const POST = apiHandler<[NextRequest, { params: Promise<{ id: string }> }]>(async (req, ctx) => {
  const requestId = withRequestId(req.headers);
  const u = await requireAdmin(req);
  if (u instanceof NextResponse) return u;

  const idParsed = RadarIdParam.safeParse(await ctx.params);
  if (!idParsed.success) {
    return toApiErrorResponse({
      code: ERROR_CODES.VALIDATION_FAILED,
      message: 'id 必须为 UUID',
      requestId,
      details: idParsed.error.flatten(),
    });
  }

  const source = await prisma.summary.findUnique({
    where: { id: idParsed.data.id },
    select: {
      id: true,
      title: true,
      body: true,
      url: true,
      source: true,
      syncRunId: true,
      tags: true,
      interpretation: true,
      shareSource: { select: { status: true } },
    },
  });
  const isAutomaticRadar = source?.source === 'daily' && source.syncRunId !== null;
  const isApprovedShare = source?.source === 'user' && source.shareSource?.status === 'approved';
  if (!source || (!isAutomaticRadar && !isApprovedShare)) {
    return toApiErrorResponse({
      code: ERROR_CODES.DRAFT_NOT_FOUND,
      message: '雷达候选不存在',
      requestId,
    });
  }

  // 预填内容：title 透传；body 取摘要 + 解读拼接；background 用解读；tags 沿用
  const prefilledTitle = source.title.length > 200
    ? source.title.slice(0, 200)
    : source.title;
  const prefilledBody = [
    source.body,
    '',
    '> 来源候选解读：',
    source.interpretation ?? '（暂无解读）',
  ].join('\n');
  const prefilledBackground = source.interpretation
    ? `基于雷达候选自动生成。原始候选：${source.url}`
    : `基于雷达候选自动生成。原始候选：${source.url}`;

  // CHECK constraint research_ai_origin_hash_required 要求 creationMethod='ai_research'
  // 时 originContentSha256 必须非空。这里用源候选正文 + AI 解读的 SHA-256 作为"原始内容指纹"，
  // 发布闸门可以拿它和当前 research.body 的 hash 对比，识别"AI 草稿是否被改过"——
  // 防止没改的草稿直接被发布（schema.prisma 注释：阻止未修改 AI 草稿直接发布）。
  const originContentSha256 = createHash('sha256')
    .update(source.body ?? '')
    .update('\x00')
    .update(source.interpretation ?? '')
    .digest('hex');

  const actionRequestId = newAdminActionRequestId();

  const result = await prisma.$transaction(async (tx) => {
    const research = await tx.research.create({
      data: {
        type: RESEARCH_TYPE.RESEARCH,
        status: RESEARCH_STATUS.DRAFT,
        title: prefilledTitle,
        body: prefilledBody,
        background: prefilledBackground,
        conclusion: null,
        risks: null,
        tags: source.tags,
        authorId: u.id,
        aiAssisted: false,
        creationMethod: CREATION_METHOD.AI_RESEARCH,
        originContentSha256,
      },
      select: {
        id: true,
        type: true,
        status: true,
        title: true,
        creationMethod: true,
        authorId: true,
        createdAt: true,
      },
    });

    // 挂载 sourceRef 指向原候选（canonicalKey 用 url）
    const sourceRef = {
      type: 'url' as const,
      value: source.url,
      required: false,
    };
    await tx.researchSource.create({
      data: {
        researchId: research.id,
        sourceRef,
        canonicalKey: source.url,
        title: source.title,
        description: source.interpretation,
      },
    });

    await writeAdminAction(tx, {
      actorId: u.id,
      action: ADMIN_RADAR_ACTIONS.CREATE_RESEARCH,
      targetType: ADMIN_TARGET_TYPE.RADAR_SUMMARY,
      targetId: source.id,
      requestId: actionRequestId,
      metadata: {
        researchId: research.id,
        candidateTitle: source.title,
        candidateUrl: source.url,
      },
    });

    return research;
  });

  log.info('admin.radar.createResearch', 'research draft created from candidate', {
    requestId,
    userId: u.id,
    summaryId: source.id,
    researchId: result.id,
    actionRequestId,
  });

  return NextResponse.json({
    ok: true,
    research: {
      id: result.id,
      title: result.title,
      status: result.status,
      creationMethod: result.creationMethod,
      authorId: result.authorId,
      createdAt: result.createdAt.toISOString(),
    },
    actionRequestId,
    sourceUrl: source.url,
  });
});
