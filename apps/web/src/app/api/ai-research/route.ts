// BFF handler: POST /api/ai-research — 创建并提交 AI 调研任务。
//
// 契约源：
//   - packages/shared/src/schemas.ts CreateAiJobInput / CreateAiJobInputV2
//   - docs/contracts/api-schemas.md §路由前缀：/api/ai/* 由 web 反代 ai-engine
//   - docs/contracts/error-codes.md §"AI 调研" 错误码（透传）
//
// BFF 行为：
//   1. requireUser
//   2. 优先按 V2 入参解析（brief / objective / primaryTopicId），缺时回退 V1
//   3. 持久化 AiResearchJob（含 objective / brief / primaryTopicId）
//   4. 若 primaryTopicId 提供，自动 upsert TopicFollow（auto-on-research）
//   5. 转发到 ai-engine 的 /api/ai/jobs（沿用旧 job_id + topic 串）
//   6. 把 ai-engine 的 status + body 透回客户端
//
// V2 不动 ai-engine，brief 仅作为本地元数据为后续 optimize /
// 卡片展示做准备；研究真正执行仍由 GPT Researcher 跑。

import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import {
  CreateAiJobInput,
  CreateAiJobInputV2,
  type ResearchBrief,
  type ResearchScope,
} from '@deep-research/shared/schemas';
import { ERROR_CODES } from '@deep-research/shared/errors';

import { apiHandler, parseBody } from '@/lib/api-handler';
import { requireUser } from '@/lib/auth/session';
import { toApiErrorResponse } from '@/lib/errors';
import { log, withRequestId } from '@/lib/log';
import { getWebEnv } from '@/lib/env';
import { prisma } from '@/lib/db';
import { recordProductEvent } from '@/lib/product-events';

const AI_ENGINE_TIMEOUT_MS = 10_000;

interface SubmitAiJobBodyOut {
  job_id: string;
  status: string;
  final_status?: string | null;
  current_step?: string | null;
  sources_count?: number;
  token_input_total?: number;
  token_output_total?: number;
  cost_cents?: number;
  search_count?: number;
  error_code?: string | null;
  error_message?: string | null;
  request_id?: string | null;
}

export const dynamic = 'force-dynamic';

function briefFallbackTopic(
  brief: { question: string } | undefined,
  v1Topic: string | undefined,
): string {
  const candidate = (brief?.question ?? v1Topic ?? '').trim();
  return candidate.slice(0, 200);
}

function scopeInstruction(scope: ResearchScope | undefined): string {
  if (!scope) return '';
  const timeRange = scope.timeRange.preset === 'custom'
    ? `${scope.timeRange.from ?? '?'} 至 ${scope.timeRange.to ?? '?'}`
    : ({ any: '不限时间', '7d': '最近 7 天', '30d': '最近 30 天', '90d': '最近 90 天', '1y': '最近 1 年' }[scope.timeRange.preset] ?? '不限时间');
  return [
    '[用户确认的检索限定]',
    `- 时间范围：${timeRange}`,
    ...(scope.regions.length > 0 ? [`- 地区偏好：${scope.regions.join('、')}`] : []),
    ...(scope.technologyVersions.length > 0 ? [`- 技术版本偏好：${scope.technologyVersions.join('、')}`] : []),
    ...(scope.retrievalNotes ? [`- 其他检索限定：${scope.retrievalNotes}`] : []),
    '这些内容用于指导资料检索、筛选和结论判断，不等同于网页级硬过滤。无法确认是否符合时，明确标记“范围未确认”，不要把推测写成事实。',
  ].join('\n');
}

function briefInstruction(brief: ResearchBrief | undefined): string {
  if (!brief) return '';
  const lines = [
    '[用户确认的研究计划]',
    `- 研究目标：${brief.objective}`,
    `- 核心问题：${brief.question}`,
    ...(brief.questionsToAnswer.length > 0
      ? ['- 必须回答的问题：', ...brief.questionsToAnswer.map((item) => `  - ${item}`)]
      : []),
    ...(brief.comparisonOptions.length > 0
      ? ['- 必须比较的对象或方案：', ...brief.comparisonOptions.map((item) => `  - ${item}`)]
      : []),
    ...(brief.constraints.length > 0
      ? ['- 已知约束：', ...brief.constraints.map((item) => `  - ${item}`)]
      : []),
    ...(brief.successCriteria.length > 0
      ? ['- 用户定义的完成标准：', ...brief.successCriteria.map((item) => `  - ${item}`)]
      : []),
    '研究时优先覆盖这些问题；每个问题都要寻找可回链的直接证据。没有足够证据时保留为待核验，不要用相邻资料替代。',
  ];
  return lines.join('\n');
}

export const POST = apiHandler<[NextRequest]>(async (req) => {
  const requestId = withRequestId(req.headers);
  const u = await requireUser(req);
  if (u instanceof NextResponse) return u;

  // V2 入参优先；缺 brief 时回退到 V1 输入。
  let v2: ReturnType<typeof CreateAiJobInputV2.parse> | null = null;
  let v1: ReturnType<typeof CreateAiJobInput.parse> | null = null;

  const bodyText = await req.text();
  let parsedAny: unknown;
  try {
    parsedAny = JSON.parse(bodyText);
  } catch {
    parsedAny = null;
  }
  if (parsedAny && typeof parsedAny === 'object' && 'brief' in (parsedAny as Record<string, unknown>)) {
    const parsed = CreateAiJobInputV2.safeParse(parsedAny);
    if (!parsed.success) {
      return NextResponse.json(
        {
          code: 'VALIDATION_FAILED',
          message: '创建调研请求校验失败',
          details: parsed.error.flatten(),
          requestId,
        },
        { status: 422 },
      );
    }
    v2 = parsed.data;
  } else {
    const parsed = CreateAiJobInput.safeParse(parsedAny);
    if (!parsed.success) {
      return NextResponse.json(
        {
          code: 'VALIDATION_FAILED',
          message: '创建调研请求校验失败',
          details: parsed.error.flatten(),
          requestId,
        },
        { status: 422 },
      );
    }
    v1 = parsed.data;
  }

  const topic = briefFallbackTopic(v2?.brief, v1?.topic);
  const reportType = v2?.reportType ?? v1?.reportType ?? 'research_report';
  const reportLength = v2?.reportLength ?? v1?.reportLength ?? (reportType === 'summary_brief' ? 'brief' : 'deep');
  const maxUrlsToScrape = v2?.maxUrlsToScrape ?? v1?.maxUrlsToScrape ?? null;
  const sourcePolicy = v2?.sourcePolicy ?? v1?.sourcePolicy ?? 'prefer_user_sources';
  const sourceRefs = v2?.sourceRefs ?? v1?.sourceRefs ?? [];
  const objective = v2?.brief?.objective ?? (v1 ? 'investigate' : 'investigate');
  const primaryTopicId = v2?.primaryTopicId ?? v2?.brief?.primaryTopicId ?? null;
  // 把用户明确指定的资料也写入 brief.contextRefs。引擎运行时可能会
  // 追加 auto radar refs；结果页据此才能区分“用户选的”与“系统参考的”。
  const brief = v2?.brief
    ? {
        ...v2.brief,
        contextRefs: Array.from(new Map(
          [...v2.brief.contextRefs, ...sourceRefs].map((ref) => [`${ref.type}:${ref.value}`, ref]),
        ).values()),
      }
    : null;
  const context = v2?.context ?? v1?.context ?? null;
  const idempotencyKey = v2?.idempotencyKey ?? v1?.idempotencyKey ?? null;
  const conversationId = v2?.conversationId ?? v1?.conversationId ?? null;
  const conversation = v2?.conversation ?? v1?.conversation ?? [];
  const engineContext = [context?.trim(), briefInstruction(brief ?? undefined), scopeInstruction(brief?.scope)]
    .filter(Boolean)
    .join('\n\n') || null;

  // 1. 落库 AiResearchJob（先有 id，方便后续埋点 / 草稿关联）
  let jobId: string;
  try {
    const job = await prisma.aiResearchJob.create({
      data: {
        requesterId: u.id,
        topic,
        context,
        reportType,
        // Keep the persisted artifact contract aligned with the requested
        // output. The engine may finish after this BFF-created row exists;
        // leaving the default "markdown" here makes a successful slides
        // run fail the terminal-state database check.
        artifactType: reportType === 'slides' ? 'slides' : 'markdown',
        reportLength,
        maxUrlsToScrape,
        sourcePolicy,
        objective,
        brief: brief ?? undefined,
        primaryTopicId,
        sourceRefs: sourceRefs,
        partialSources: [],
        failedSources: [],
        idempotencyKey,
        conversation,
      },
      select: { id: true },
    });
    jobId = job.id;
  } catch (err) {
    log.error('ai.bff.create_job_failed', 'create failed', { requestId, userId: u.id, error: String(err) });
    return NextResponse.json(
      {
        code: ERROR_CODES.AI_ENGINE_UNAVAILABLE,
        message: '创建调研任务失败',
        requestId,
      },
      { status: 503 },
    );
  }

  // 2. 自动关注主专题（高置信匹配由 /api/ai-research/plan 提供）
  if (primaryTopicId) {
    const exists = await prisma.topic.findUnique({
      where: { id: primaryTopicId },
      select: { id: true, slug: true },
    });
    if (exists) {
      await prisma.topicFollow.upsert({
        where: { userId_topicId: { userId: u.id, topicId: exists.id } },
        create: { userId: u.id, topicId: exists.id },
        update: {},
      });
      await recordProductEvent({
        userId: u.id,
        eventType: 'topic_research_started',
        targetType: 'topic',
        targetId: exists.id,
        metadata: { jobId, slug: exists.slug, objective },
      });
    }
  }

  // 2.5 V2 闭环埋点：用户带 contextRefs 提交 = 复用历史上下文
  if (sourceRefs.length > 0 || (typeof context === 'string' && context.trim().length > 0)) {
    await recordProductEvent({
      userId: u.id,
      eventType: 'research_context_reused',
      targetType: 'ai_research_job',
      targetId: jobId,
      metadata: {
        sourceRefCount: sourceRefs.length,
        hasFreeTextContext: typeof context === 'string' && context.trim().length > 0,
      },
    }).catch(() => undefined);
  }

  // 3. 转发到 ai-engine（沿用旧 topic / context / reportType / sourcePolicy 语义）
  const env = getWebEnv();
  const url = `${env.AI_ENGINE_URL.replace(/\/$/u, '')}/api/ai/jobs`;
  const upstreamPayload = {
    job_id: jobId,
    requester_id: u.id,
    topic,
    context: engineContext,
    report_type: reportType,
    report_length: reportLength,
    max_urls_to_scrape: maxUrlsToScrape,
    source_policy: sourcePolicy,
    idempotency_key: idempotencyKey,
    source_refs: sourceRefs.map((r) => ({
      type: r.type,
      value: r.value,
      required: r.required,
    })),
  };

  let upstreamRes: Response;
  try {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), AI_ENGINE_TIMEOUT_MS);
    upstreamRes = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Request-Id': requestId },
      body: JSON.stringify(upstreamPayload),
      signal: ac.signal,
      cache: 'no-store',
    });
  } catch (err) {
    log.error('ai.bff.upstream_unreachable', 'upstream unreachable', { requestId, jobId, error: String(err) });
    return toApiErrorResponse({
      code: ERROR_CODES.AI_ENGINE_UNAVAILABLE,
      message: 'AI engine 不可达',
      requestId,
    });
  }

  const upstreamBody = await upstreamRes.text();

  if (!upstreamRes.ok) {
    let parsed: { code?: string; message?: string; requestId?: string; details?: unknown } = {};
    try {
      parsed = JSON.parse(upstreamBody);
    } catch {
      parsed = {};
    }
    return toApiErrorResponse({
      code: (parsed.code as keyof typeof ERROR_CODES | undefined) ?? ERROR_CODES.AI_ENGINE_UNAVAILABLE,
      message: parsed.message ?? `ai-engine 返回 ${upstreamRes.status}`,
      requestId: parsed.requestId ?? requestId,
      details: parsed.details,
    });
  }

  let upstream: SubmitAiJobBodyOut;
  try {
    upstream = JSON.parse(upstreamBody) as SubmitAiJobBodyOut;
  } catch {
    return toApiErrorResponse({
      code: ERROR_CODES.AI_ENGINE_UNAVAILABLE,
      message: 'ai-engine 返回非 JSON',
      requestId,
    });
  }

  log.info('ai.bff.submit', 'ok', {
    requestId,
    userId: u.id,
    jobId,
    reportType,
    objective,
    primaryTopicId,
  });

  // 绑定持久化对话：任务创建成功后把 jobId 写回会话，
  // 任务页与 follow-up 追问都能从会话恢复完整历史。
  if (conversationId) {
    const conversationRow = await prisma.aiResearchConversation.findUnique({
      where: { id: conversationId },
      select: { userId: true, jobId: true },
    });
    if (conversationRow && conversationRow.userId === u.id && !conversationRow.jobId) {
      await prisma.aiResearchConversation.update({
        where: { id: conversationId },
        data: { jobId },
      });
    }
  }

  return NextResponse.json(
    {
      jobId,
      status: upstream.status,
      finalStatus: upstream.final_status ?? null,
      currentStep: upstream.current_step ?? null,
      sourcesCount: upstream.sources_count ?? 0,
      objective,
      primaryTopicId,
      brief,
    },
    { status: upstreamRes.status },
  );
});

function cryptoUuid(): string {
  // Web Crypto is universally available; v4-style fallback below for safety
  const g = globalThis as unknown as { crypto?: { randomUUID?: () => string } };
  if (g.crypto?.randomUUID) return g.crypto.randomUUID();
  const rnd = () => Math.floor(Math.random() * 0x10000).toString(16).padStart(4, '0');
  return `${rnd()}${rnd()}-${rnd()}-4${rnd().slice(1)}-${rnd()}-${rnd()}${rnd()}${rnd()}`;
}
