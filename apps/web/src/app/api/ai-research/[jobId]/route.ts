// BFF handler: 查询 AI 调研任务状态（架构 §七 GET /api/ai-research/{id}/status）。
//
// 前端每 5s 轮询本端，本端反代 ai-engine GET /api/ai/jobs/{id}。
// 验收 4：状态轮询 ≤5s 间隔 —— 由前端 useQuery { refetchInterval: 5000 } 负责，
// 本端只做无状态透传。

import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { z } from 'zod';
import { ERROR_CODES } from '@deep-research/shared/errors';
import { apiHandler } from '../../../../lib/api-handler';
import { prisma } from '../../../../lib/db';
import { requireUser } from '../../../../lib/auth/session';
import { toApiErrorResponse } from '../../../../lib/errors';
import { log, withRequestId } from '../../../../lib/log';
import { getWebEnv } from '../../../../lib/env';
import { fetchAiEngine } from '../../../../lib/ai-bff/fetch-ai-engine';
import {
  buildEvidenceDigest,
  cleanResearchReportForReader,
  extractResearchTitle,
  isEvidenceOnlyResearchOutput,
  renderSlidesArtifactContent,
} from '../../../../lib/research-report';
import type { ResearchArtifact } from '@deep-research/shared';
import { ResearchBriefSchema } from '@deep-research/shared/schemas';
import { resolveCurrentReviewState } from '../../../../lib/research-review-state';
import {
  asReviewClaims,
  claimHasCapturedSourceMatch,
  getReviewPublicationGate,
  reviewClaimNextAction,
  reviewCoverageStatus,
} from '../../../../lib/research-review-decisions';
import { evaluateResearchSufficiency } from '../../../../lib/research-sufficiency';

const IdParam = z.object({ jobId: z.string().uuid() });

function projectReviewClaims(
  value: unknown,
  sources: Array<{ title?: string | null; snippet?: string | null }> = [],
): unknown {
  if (!Array.isArray(value)) return value;
  return value.map((raw) => {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return raw;
    const parsed = asReviewClaims([raw])[0];
    if (!parsed) return raw;
    const baseAction = reviewClaimNextAction(parsed);
    const nextAction = baseAction === 'find_more_evidence' && claimHasCapturedSourceMatch(parsed, sources)
      ? 'reverify_current_sources'
      : baseAction;
    return parsed
      ? { ...(raw as Record<string, unknown>), nextAction }
      : raw;
  });
}

interface UpstreamJobOut {
  job_id: string;
  status: string;
  topic?: string | null;
  final_status?: string | null;
  current_step?: string | null;
  sources_count?: number;
  partial_sources_count?: number;
  failed_sources_count?: number;
  error_stage?: string | null;
  token_input_total?: number;
  token_output_total?: number;
  cost_cents?: number;
  draft_research_id?: string | null;
  report_type?: string | null;
  output_text?: string | null;
  error_code?: string | null;
  error_message?: string | null;
  error_details?: Record<string, unknown> | null;
  request_id?: string | null;
  started_at?: string | null;
  created_at?: string | null;
  completed_at?: string | null;
  review?: Record<string, unknown> | null;
  review_run?: Record<string, unknown> | null;
  research_progress?: Record<string, unknown> | null;
}

export const GET = apiHandler<[NextRequest, { params: Promise<{ jobId: string }> }]>(async (req, ctx) => {
  const requestId = withRequestId(req.headers);
  const u = await requireUser(req);
  if (u instanceof NextResponse) return u;

  const parsed = IdParam.safeParse(await ctx.params);
  if (!parsed.success) {
    return toApiErrorResponse({
      code: ERROR_CODES.VALIDATION_FAILED,
      message: 'jobId 必须为 UUID',
      requestId,
      details: parsed.error.flatten(),
    });
  }

  // 归属校验（W9 code review 修订，S0 越权）：
  // 此前本端只做 requireUser（确认已登录）就把 jobId 透传给上游，
  // 而上游 GET /api/ai/jobs/{id} 也只按 job_id 取行，任何登录用户
  // 拿到别人的 jobId 即可读到其 costCents / tokenTotal / errorMessage /
  // draftResearchId。这里在反代前先确认 job 属于当前用户。
  // 非 owner 一律返回 AI_JOB_NOT_FOUND（而非 PERMISSION_DENIED），
  // 避免把「该 job 存在」这一事实泄露出去。
  const job = await prisma.aiResearchJob.findUnique({
    where: { id: parsed.data.jobId },
    select: {
      requesterId: true,
      context: true,
      sourcePolicy: true,
      reportLength: true,
      sourceRefs: true,
      brief: true,
      conversation: true,
      partialSources: true,
      updatedAt: true,
      draftResearch: {
        select: {
          title: true,
          body: true,
          background: true,
          conclusion: true,
          risks: true,
          tags: true,
          researchSources: {
            orderBy: { createdAt: 'asc' },
            select: {
              id: true,
              sourceRef: true,
              canonicalKey: true,
              title: true,
              description: true,
              createdAt: true,
            },
          },
          reviewRuns: {
            orderBy: { createdAt: 'desc' },
            take: 50,
            select: {
              id: true,
              revisionHash: true,
              sourceSnapshotHash: true,
              policyVersion: true,
              executionStatus: true,
              outcome: true,
              attempt: true,
              startedAt: true,
              leaseExpiresAt: true,
              heartbeatAt: true,
              completedAt: true,
              summary: true,
              claims: true,
              details: true,
              triggeredBy: true,
              createdAt: true,
              decisions: {
                orderBy: { createdAt: 'asc' },
                select: {
                  id: true,
                  claimId: true,
                  revisionHash: true,
                  action: true,
                  reason: true,
                  metadata: true,
                  actorId: true,
                  createdAt: true,
                },
              },
            },
          },
          audit: {
            where: { action: { in: ['edit', 'revert'] } },
            select: { id: true },
          },
        },
      },
      aiResearchSources: {
        orderBy: { createdAt: 'desc' },
        select: {
          id: true,
          title: true,
          snippet: true,
          score: true,
          sourceRef: true,
          canonicalKey: true,
          stepCaptured: true,
          createdAt: true,
        },
      },
      _count: {
        select: { aiResearchSources: true },
      },
    },
  });
  if (job === null || job.requesterId !== u.id) {
    return toApiErrorResponse({
      code: ERROR_CODES.AI_JOB_NOT_FOUND,
      message: '任务不存在',
      requestId,
    });
  }

  const env = getWebEnv();
  const url = `${env.AI_ENGINE_URL.replace(/\/$/u, '')}/api/ai/jobs/${parsed.data.jobId}`;

  const fetched = await fetchAiEngine<UpstreamJobOut>({
    url,
    requestId,
    context: 'ai.bff.status',
  });
  if (!fetched.ok) {
    return toApiErrorResponse({
      code: fetched.code,
      message: fetched.message,
      requestId: fetched.requestId,
    });
  }
  const up = fetched.body;
  // The engine can reach a terminal state just before the DB runner commits
  // the draft relation. Recover the draft by the stable id returned by the
  // engine so a single boundary poll cannot produce a permanently empty
  // result page.
  let draftResearch = job.draftResearch;
  if (!draftResearch && up.draft_research_id) {
    draftResearch = await prisma.research.findUnique({
      where: { id: up.draft_research_id },
      select: {
        title: true,
        body: true,
        background: true,
        conclusion: true,
        risks: true,
        tags: true,
        researchSources: {
          orderBy: { createdAt: 'asc' },
          select: {
            id: true,
            sourceRef: true,
            canonicalKey: true,
            title: true,
            description: true,
            createdAt: true,
          },
        },
        reviewRuns: {
          orderBy: { createdAt: 'desc' },
          take: 50,
          select: {
            id: true,
            revisionHash: true,
            sourceSnapshotHash: true,
            policyVersion: true,
            executionStatus: true,
            outcome: true,
            attempt: true,
            startedAt: true,
            leaseExpiresAt: true,
            heartbeatAt: true,
            completedAt: true,
            summary: true,
            claims: true,
            details: true,
            triggeredBy: true,
            createdAt: true,
            decisions: {
              orderBy: { createdAt: 'asc' },
              select: {
                id: true,
                claimId: true,
                revisionHash: true,
                action: true,
                reason: true,
                metadata: true,
                actorId: true,
                createdAt: true,
              },
            },
          },
        },
        audit: {
          where: { action: { in: ['edit', 'revert'] } },
          select: { id: true },
        },
      },
    });
  }
  // Keep the response list compact for the page, but use the complete
  // captured ledger when sanitizing report links. A deep run can save more
  // than the 24 sources shown in the collapsed UI; hiding the older rows
  // must not turn their valid citations into “unverified” text.
  const jobEvidenceSources = job.aiResearchSources.length > 0
    ? job.aiResearchSources.map((source) => ({
        id: source.id,
        title: sourceDisplayTitle(source.title, source.sourceRef, source.canonicalKey),
        snippet: source.snippet,
        score: source.score,
        sourceRef: source.sourceRef,
        canonicalKey: source.canonicalKey,
        stepCaptured: source.stepCaptured,
        capturedAt: source.createdAt.toISOString(),
      }))
    : legacyEvidenceSources(job.partialSources, parsed.data.jobId, job.updatedAt);
  // The draft's source ledger is the durable evidence boundary for the
  // research artifact. A claim-evidence task can add sources after the
  // original AI job has finished; projecting only aiResearchSources here
  // would make the new review run appear to use evidence that the page cannot
  // show. Prefer the research ledger and only use job sources to backfill
  // legacy rows that were never attached to the draft.
  const researchLedgerSources = draftResearch?.researchSources?.map((source) => ({
    id: source.id,
    title: sourceDisplayTitle(source.title, source.sourceRef, source.canonicalKey),
    snippet: source.description,
    score: null,
    sourceRef: source.sourceRef,
    canonicalKey: source.canonicalKey,
    stepCaptured: 'research_ledger',
    capturedAt: source.createdAt.toISOString(),
  })) ?? [];
  const researchLedgerKeys = new Set(researchLedgerSources.map((source) => source.canonicalKey));
  const allEvidenceSources = [
    ...researchLedgerSources,
    ...jobEvidenceSources.filter((source) => !researchLedgerKeys.has(source.canonicalKey)),
  ];
  const evidenceSources = allEvidenceSources.slice(0, 24);
  const savedSourcesCount = allEvidenceSources.length;
  const capturedSourcesCount = allEvidenceSources.filter((source) => Boolean(source.snippet?.trim())).length;
  const artifactType = up.report_type === 'slides' ? 'slides' : 'markdown';
  const parsedBrief = ResearchBriefSchema.safeParse(job.brief);
  const researchSufficiency = evaluateResearchSufficiency({
    brief: parsedBrief.success ? parsedBrief.data : null,
    sources: allEvidenceSources,
    sourceCoverage: readSourceCoverage(up.research_progress),
    sourcePolicy: job.sourcePolicy,
  });
  const storedSourceRefs = Array.isArray(job.sourceRefs) ? job.sourceRefs : [];
  const explicitSourceKeys = new Set(
    parsedBrief.success
      ? parsedBrief.data.contextRefs.map((ref) => `${ref.type}:${ref.value}`)
      : [],
  );
  const autoSourceRefsCount = storedSourceRefs.filter((ref) => (
    isSourceRefRecord(ref)
    && (ref.auto === true || (
      job.sourcePolicy === 'prefer_user_sources'
      && ref.type === 'summary'
      && !explicitSourceKeys.has(`${ref.type}:${ref.value}`)
    ))
  )).length;
  const userSourceRefsCount = Math.max(0, storedSourceRefs.length - autoSourceRefsCount);
  const upstreamReportContent = up.output_text?.trim() ? up.output_text : null;
  // Once a user applies a follow-up revision, the editable draft becomes the
  // source of truth. Fall back to upstream output only for jobs without a
  // saved draft body.
  const storedReportContent = draftResearch?.body?.trim()
    ? draftResearch.body
    : upstreamReportContent ?? null;
  // A late worker timeout can leave a durable evidence ledger without any
  // writer output. Make that work inspectable at the presentation boundary;
  // this is a read-only snapshot, never a synthesized report.
  const evidenceSnapshot = !storedReportContent
    ? buildEvidenceDigest(
        up.topic ?? 'AI 调研',
        evidenceSources.map((source) => ({
          title: source.title,
          snippet: source.snippet,
          href: sourceHref(source.sourceRef, source.canonicalKey),
          capturedAt: source.capturedAt,
        })),
      )
    : null;
  const rawReportContent = storedReportContent ?? evidenceSnapshot;
  const evidenceOnly = isEvidenceOnlyResearchOutput(rawReportContent);
  // Older jobs could persist the evidence digest behind a `succeeded` status.
  // Derive the user-facing status from the actual deliverable so a source
  // list can never masquerade as a completed report.
  const effectiveFinalStatus = evidenceOnly && up.final_status === 'succeeded'
    ? 'partial'
    : up.final_status ?? null;
  const reportVersion = 1 + (draftResearch?.audit?.length ?? 0);
  const cleanedReportContent = rawReportContent
    ? cleanResearchReportForReader(
        rawReportContent,
        allEvidenceSources
          .map((source) => sourceHref(source.sourceRef, source.canonicalKey))
          .filter((href): href is string => href !== null),
      )
    : null;
  // A few early Slides drafts were persisted before the engine-side renderer
  // was wired through the final draft boundary. Normalize them here as an
  // idempotent compatibility step so the reader never sees a whole report as
  // one giant slide. Evidence-only snapshots stay snapshots and must not be
  // promoted into a deck.
  const reportContent = cleanedReportContent && artifactType === 'slides' && !evidenceOnly
    ? renderSlidesArtifactContent(cleanedReportContent, up.topic ?? 'AI 调研')
    : cleanedReportContent;
  // Legacy jobs may carry a review snapshot from a report-writing attempt
  // even though the durable body is only an evidence digest. That digest is
  // deliberately not a report and never entered fact review; do not let the
  // stale snapshot label the evidence checkpoint as “needs revision”.
  const reviewRuns = draftResearch?.reviewRuns ?? [];
  const latestReviewRun = reviewRuns[0] ?? null;
  const upstreamReviewStatus = typeof up.review?.status === 'string'
    ? up.review.status
    : null;
  const reviewState = evidenceOnly
    ? null
    : resolveCurrentReviewState(draftResearch ?? {}, reviewRuns, upstreamReviewStatus);
  const reviewMatchesCurrentRevision = reviewState?.isCurrentRevision ?? null;
  // Keep historical runs visible for audit purposes, but only expose the run
  // that covers the exact current revision as the active ledger. A latest run
  // with another hash is returned as stale solely to explain why publishing
  // is blocked; its claims are deliberately ignored by the page.
  const reviewRun = evidenceOnly
    ? null
    : reviewState?.run
      ?? (latestReviewRun ? { ...latestReviewRun, executionStatus: 'stale', outcome: 'stale' } : null);
  const currentRunReview = reviewState?.run
    ? {
        // The upstream job mirror is useful for compatibility fields that
        // are not yet present on a run, but the run owns every verdict-like
        // field. In particular, never let a previous `passed` mirror leak
        // into a newly queued/reviewing run for the same draft.
        ...(up.review ?? {}),
        phase: reviewState.status === 'queued' || reviewState.status === 'reviewing'
          ? reviewState.status
          : 'completed',
        status: reviewState.status === 'passed'
          ? 'passed'
          : reviewState.status === 'needs_action'
            ? 'needs_action'
          : reviewState.status === 'needs_revision'
            ? 'needs_revision'
            : reviewState.status === 'blocked'
              ? 'blocked'
              : reviewState.status === 'review_unavailable'
                ? 'review_unavailable'
                : reviewState.status,
        review_outcome: reviewState.run.outcome,
        attempts: reviewState.run.attempt,
        summary: reviewState.run.summary ?? null,
        claims: projectReviewClaims(reviewState.run.claims, allEvidenceSources),
        details: reviewState.run.details ?? null,
        decisions: reviewState.run.decisions ?? [],
        publicationGate: getReviewPublicationGate({
          executionStatus: reviewState.run.executionStatus,
          outcome: reviewState.run.outcome,
          coverageStatus: reviewCoverageStatus(reviewState.run.summary),
          researchSufficiencyStatus: researchSufficiency.status,
          claims: reviewState.run.claims,
          decisions: reviewState.run.decisions,
        }),
      }
    : null;
  const effectiveReview = evidenceOnly
    ? null
    : reviewState?.status === 'stale'
      ? {
          phase: 'completed',
          status: 'stale',
          review_outcome: 'unknown',
          attempts: 0,
          claims: [],
          summary: null,
          details: null,
          error: '当前草稿已修改，需要重新审核。',
        }
      : reviewState?.isCurrentRevision
        ? currentRunReview ?? up.review
        : null;
  const artifact: ResearchArtifact | null = reportContent
    ? {
        type: artifactType,
        title: extractResearchTitle(reportContent, draftResearch?.title ?? up.topic ?? 'AI 调研结果'),
        version: reportVersion,
        mimeType: 'text/markdown',
        content: reportContent,
        rawContent: rawReportContent,
        payload: null,
        sourceRefs: allEvidenceSources.map((source) => ({
          type: sourceRefType(source.sourceRef),
          value: sourceHref(source.sourceRef, source.canonicalKey) ?? source.canonicalKey,
          title: source.title ?? undefined,
        })),
        sourceHash: null,
        draftResearchId: up.draft_research_id ?? null,
      }
    : up.draft_research_id
      ? {
          type: artifactType,
          title: up.topic ?? 'AI 调研草稿',
          version: reportVersion,
          mimeType: 'text/markdown',
          content: null,
          rawContent: null,
          payload: null,
          sourceRefs: [],
          sourceHash: null,
          draftResearchId: up.draft_research_id,
        }
      : null;
  return NextResponse.json({
    jobId: up.job_id,
    status: up.status,
    topic: up.topic ?? null,
    finalStatus: effectiveFinalStatus,
    deliverableStatus: evidenceOnly ? 'evidence_only' : reportContent ? 'report' : 'none',
    currentStep: up.current_step ?? null,
    sourcesCount: up.sources_count ?? 0,
    savedSourcesCount,
    capturedSourcesCount,
    userSourceRefsCount,
    autoSourceRefsCount,
    partialSourcesCount: up.partial_sources_count ?? 0,
    failedSourcesCount: up.failed_sources_count ?? 0,
    errorStage: up.error_stage ?? null,
    tokenInputTotal: up.token_input_total ?? 0,
    tokenOutputTotal: up.token_output_total ?? 0,
    costCents: up.cost_cents ?? 0,
    draftResearchId: up.draft_research_id ?? null,
    reportType: up.report_type ?? null,
    reportLength: job.reportLength ?? 'standard',
    sourcePolicy: job.sourcePolicy,
    context: job.context,
    sourceRefs: storedSourceRefs,
    brief: parsedBrief.success ? parsedBrief.data : null,
    outputText: up.output_text ?? null,
    errorCode: up.error_code ?? null,
    errorMessage: up.error_message ?? null,
    errorDetails: up.error_details ?? null,
    startedAt: up.started_at ?? null,
    createdAt: up.created_at ?? null,
    completedAt: up.completed_at ?? null,
    review: effectiveReview,
    reviewRun: reviewRun
      ? {
          id: reviewRun.id,
          revisionHash: reviewRun.revisionHash,
          sourceSnapshotHash: reviewRun.sourceSnapshotHash ?? '',
          policyVersion: reviewRun.policyVersion ?? 'fact-review-v1',
          executionStatus: reviewRun.executionStatus,
          outcome: reviewRun.outcome,
          attempt: reviewRun.attempt,
          startedAt: toIso(reviewRun.startedAt),
          leaseExpiresAt: toIso(reviewRun.leaseExpiresAt),
          heartbeatAt: toIso(reviewRun.heartbeatAt),
          completedAt: toIso(reviewRun.completedAt),
          summary: reviewRun.summary,
          claims: projectReviewClaims(reviewRun.claims, allEvidenceSources),
          details: reviewRun.details,
          decisions: reviewRun.decisions ?? [],
          publicationGate: getReviewPublicationGate({
            executionStatus: reviewRun.executionStatus,
            outcome: reviewRun.outcome,
            coverageStatus: reviewCoverageStatus(reviewRun.summary),
            researchSufficiencyStatus: researchSufficiency.status,
            claims: reviewRun.claims,
            decisions: reviewRun.decisions,
          }),
          triggeredBy: reviewRun.triggeredBy ?? 'system',
          createdAt: toIso(reviewRun.createdAt) ?? new Date(0).toISOString(),
          isCurrentRevision: reviewMatchesCurrentRevision !== false,
        }
      : null,
    researchProgress: up.research_progress ?? null,
    researchSufficiency,
    conversation: Array.isArray(job.conversation) ? job.conversation : [],
    sources: evidenceSources.map((source) => ({
      id: source.id,
      title: source.title,
      snippet: source.snippet,
      score: source.score,
      href: sourceHref(source.sourceRef, source.canonicalKey),
      type: sourceRefType(source.sourceRef),
      stepCaptured: source.stepCaptured,
      capturedAt: source.capturedAt,
    })),
    artifact,
  });
});

function toIso(value: Date | string | null | undefined): string | null {
  return value ? new Date(value).toISOString() : null;
}

function readSourceCoverage(value: Record<string, unknown> | null | undefined) {
  if (!value || !isSourceRefRecord(value.sourceCoverage)) return null;
  const result: Record<string, {
    label?: string;
    captured?: number;
    requiredCaptured?: number;
    status?: string;
  }> = {};
  for (const [key, raw] of Object.entries(value.sourceCoverage)) {
    if (!isSourceRefRecord(raw)) continue;
    result[key] = {
      label: typeof raw.label === 'string' ? raw.label : undefined,
      captured: typeof raw.captured === 'number' ? raw.captured : undefined,
      requiredCaptured: typeof raw.requiredCaptured === 'number' ? raw.requiredCaptured : undefined,
      status: typeof raw.status === 'string' ? raw.status : undefined,
    };
  }
  return result;
}

function isSourceRefRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function sourceRefType(value: unknown): 'url' | 'summary' | 'research' | 'favorite' {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return 'url';
  const type = (value as Record<string, unknown>).type;
  if (type === 'summary' || type === 'research' || type === 'favorite') return type;
  return 'url';
}

function sourceHref(value: unknown, canonicalKey: string): string | null {
  let candidate = '';
  let refType = '';
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const raw = (value as Record<string, unknown>).value;
    if (typeof raw === 'string') candidate = raw;
    const type = (value as Record<string, unknown>).type;
    if (typeof type === 'string') refType = type;
  }
  // Internal sources are private app resources rather than external URLs.
  // Keep a first-class in-app link so “历史研究/雷达内容” is inspectable too.
  if (refType === 'summary' && /^[0-9a-f-]{36}$/iu.test(candidate)) return `/radar/${candidate}`;
  if (refType === 'research' && /^[0-9a-f-]{36}$/iu.test(candidate)) return `/researches/${candidate}`;
  if (refType === 'favorite' && /^[0-9a-f-]{36}$/iu.test(candidate)) return `/me/favorites`;
  if (!candidate && /^https?:\/\//iu.test(canonicalKey)) candidate = canonicalKey;
  try {
    const parsed = new URL(candidate);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:' ? parsed.toString() : null;
  } catch {
    return null;
  }
}

function legacyEvidenceSources(value: unknown, jobId: string, capturedAt: Date) {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item, index) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return [];
    const row = item as Record<string, unknown>;
    const canonicalKey = typeof row.canonical_key === 'string' ? row.canonical_key : '';
    if (!canonicalKey) return [];
    return [{
      id: `${jobId}:legacy:${index}`,
      title: sourceDisplayTitle(row.title, row.source_ref, canonicalKey),
      snippet: typeof row.snippet === 'string' ? row.snippet : null,
      score: typeof row.score === 'number' ? row.score : null,
      sourceRef: row.source_ref,
      canonicalKey,
      stepCaptured: typeof row.step_captured === 'string' ? row.step_captured : 'search',
      capturedAt: capturedAt.toISOString(),
    }];
  });
}

function sourceDisplayTitle(title: unknown, sourceRef: unknown, canonicalKey: string): string {
  if (typeof title === 'string' && title.trim() && !/^https?:\/\//iu.test(title.trim())) {
    return title.trim();
  }
  const href = sourceHref(sourceRef, canonicalKey);
  if (!href) return canonicalKey;
  try {
    const parsed = new URL(href);
    const host = parsed.hostname.replace(/^www\./u, '');
    const lastSegment = decodeURIComponent(parsed.pathname.split('/').filter(Boolean).at(-1) ?? '')
      .replace(/[-_]+/gu, ' ')
      .replace(/\.(?:html?|pdf)$/iu, '')
      .trim();
    return lastSegment ? `${host} · ${lastSegment}` : host;
  } catch {
    return canonicalKey;
  }
}
