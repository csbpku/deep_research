export type AiReviewPhase =
  | 'not_started'
  | 'queued'
  | 'reviewing'
  | 'inventorying'
  | 'adjudicating'
  | 'matching'
  | 'conflict_check'
  | 'completed';

export interface AiReviewPresentationInput {
  phase?: AiReviewPhase;
  status?: string;
  error?: string | null;
  error_code?: string | null;
}

/** The phase is a workflow checkpoint, not a factual verdict. */
export function reviewPhaseLabel(phase: string | null | undefined): string | null {
  switch (phase) {
    case 'inventorying': return '正在整理报告声明和来源清单';
    case 'adjudicating': return '正在逐条判断声明与证据的关系';
    case 'matching': return '正在把声明和可核对原文匹配';
    case 'conflict_check': return '正在检查支持关系和来源冲突';
    case 'reviewing': return '正在执行事实核验';
    case 'queued': return '等待审核任务开始';
    case 'completed': return '审核账本已完成';
    default: return null;
  }
}

export interface ReviewBatchProgress {
  batchIndex: number | null;
  batchCount: number;
  completedBatchCount: number;
  failedBatchCount: number;
  judgedClaimCount: number;
  totalClaimCount: number;
  status: string | null;
}

/**
 * Read the durable adjudication checkpoint without treating it as a verdict.
 * The checkpoint is intentionally optional so historical review runs remain
 * readable after this field was introduced.
 */
export function reviewBatchProgress(details: unknown): ReviewBatchProgress | null {
  if (!details || typeof details !== 'object' || Array.isArray(details)) return null;
  const adjudicating = (details as { adjudicating?: unknown }).adjudicating;
  if (!adjudicating || typeof adjudicating !== 'object' || Array.isArray(adjudicating)) return null;
  const value = adjudicating as Record<string, unknown>;
  const numberOr = (key: string, fallback: number) => {
    const candidate = value[key];
    return typeof candidate === 'number' && Number.isFinite(candidate) ? Math.max(0, Math.trunc(candidate)) : fallback;
  };
  const batchCount = numberOr('batch_count', 0);
  const totalClaimCount = numberOr('total_claim_count', 0);
  if (batchCount <= 0 && totalClaimCount <= 0) return null;
  const batchIndex = typeof value.batch_index === 'number' && Number.isFinite(value.batch_index)
    ? Math.max(1, Math.trunc(value.batch_index))
    : null;
  return {
    batchIndex,
    batchCount,
    completedBatchCount: numberOr('completed_batch_count', 0),
    failedBatchCount: numberOr('failed_batch_count', 0),
    judgedClaimCount: numberOr('judged_claim_count', 0),
    totalClaimCount,
    status: typeof value.batch_status === 'string' ? value.batch_status : null,
  };
}

export type ClaimDisplayStatus = 'supported' | 'unverified' | 'contradicted';

export type ClaimJudgmentStatus =
  | 'settled'
  | 'not_judged'
  | 'execution_failed'
  | 'disputed';

export interface ClaimJudgmentPresentationInput {
  judgment_status?: ClaimJudgmentStatus | string | null;
  execution_error_code?: string | null;
}

/**
 * A verdict answers an evidence question; judgment_status answers whether the
 * system actually completed that question. Keep the two axes separate so a
 * timeout or a second-opinion disagreement never renders as a factual error.
 */
export function claimJudgmentStatus(
  claim: ClaimJudgmentPresentationInput | null | undefined,
): ClaimJudgmentStatus {
  const value = claim?.judgment_status;
  return value === 'not_judged'
    || value === 'execution_failed'
    || value === 'disputed'
    ? value
    : 'settled';
}

export function claimJudgmentLabel(claim: ClaimJudgmentPresentationInput): string | null {
  switch (claimJudgmentStatus(claim)) {
    case 'not_judged': return '已识别，尚未判断';
    case 'execution_failed': return '这条还没检查完';
    case 'disputed': return '复核结果不一致';
    default: return null;
  }
}

export interface ClaimEvidencePresentationInput extends ClaimJudgmentPresentationInput {
  claim?: string | null;
  claim_type?: string | null;
  risk?: string;
  verdict?: string;
  evidence?: {
    excerpt?: string | null;
    resolver?: string | null;
  } | null;
}

export interface ReviewSummaryPresentationInput {
  review_outcome?: string | null;
  factual_claim_count?: number | null;
  citation_count?: number | null;
  citation_pending_count?: number | null;
  coverage_status?: string | null;
  corrected_count?: number | null;
  unverified_count?: number | null;
  contradicted_count?: number | null;
}

export function reviewDisplayStatus(review: AiReviewPresentationInput | null): string {
  return review?.status ?? review?.phase ?? 'not_started';
}

export function reviewDisplayLabel(review: AiReviewPresentationInput | null): string {
  const labels: Record<string, string> = {
    passed: '已通过',
    needs_action: '需要处理',
    needs_revision: '需要修订',
    coverage_insufficient: '资料范围有缺口',
    research_insufficient: '资料范围有缺口',
    blocked: '需要修改',
    review_unavailable: '暂时无法确认',
    not_applicable: '不适用',
    not_started: '等待审核',
    queued: '结果整理中',
    reviewing: '结果整理中',
    stale: '版本已更新，需要重新确认',
  };
  const status = reviewDisplayStatus(review);
  return labels[status] ?? status;
}

export type ReviewDisplayTone = 'success' | 'warning' | 'danger' | 'neutral';

/** Map review state to UI tone without treating an unavailable audit as a bad fact. */
export function reviewDisplayTone(review: AiReviewPresentationInput | null): ReviewDisplayTone {
  switch (reviewDisplayStatus(review)) {
    case 'passed': return 'success';
    case 'blocked': return 'danger';
    case 'needs_action':
    case 'needs_revision':
    case 'coverage_insufficient':
    case 'research_insufficient':
    case 'review_unavailable':
    case 'queued':
    case 'reviewing': return 'warning';
    default: return 'neutral';
  }
}

export function reviewOutcome(
  review: (AiReviewPresentationInput & ReviewSummaryPresentationInput) | null,
): 'clear' | 'attention' | 'blocked' | 'unavailable' | 'unknown' {
  const explicit = review?.review_outcome;
  if (explicit === 'clear' || explicit === 'attention' || explicit === 'blocked' || explicit === 'unavailable') {
    return explicit;
  }
  const status = reviewDisplayStatus(review);
  if (status === 'review_unavailable') return 'unavailable';
  if (status === 'blocked') return 'blocked';
  if (status === 'needs_action') return 'attention';
  if (status === 'needs_revision') return 'attention';
  if (status === 'passed') return 'clear';
  return 'unknown';
}

export function claimIsCitationRelationship(claim: ClaimEvidencePresentationInput): boolean {
  return claim.claim_type === 'citation_relationship'
    || claim.evidence?.resolver === 'captured-source-citation';
}

/**
 * Opinions and navigable citation links are not factual review work items.
 * Keeping this predicate shared prevents the summary counters and the
 * claim-level queue from disagreeing about what a person actually needs to
 * decide.
 */
export function claimIsFactual(claim: ClaimEvidencePresentationInput): boolean {
  return claim.claim_type !== 'interpretation'
    && !claimIsResearchProcessObservation(claim)
    && claim.risk?.toLowerCase() !== 'opinion'
    && claim.verdict?.toLowerCase() !== 'not_applicable'
    && !claimIsCitationRelationship(claim);
}

/** Convert persisted diagnostics into a user-facing explanation. */
export function reviewUnavailableReason(review: AiReviewPresentationInput | null): string {
  const code = review?.error_code?.toLowerCase();
  if (code === 'timeout' || review?.error?.includes('超时')) {
    return '审核服务等待超时，未完成逐条核验。';
  }
  if (code === 'invalid_output' || review?.error === 'ValueError') {
    return '审核服务返回内容无法解析，未完成逐条核验。';
  }
  if (code === 'no_captured_evidence') {
    return '本轮没有可核对正文，无法执行事实审核。';
  }
  if (code === 'provider_unavailable') {
    return '审核服务暂时不可用，未完成逐条核验。';
  }
  return '自动审核未完成，暂时无法对结论逐条判定。';
}

export function reviewProgress(phase?: AiReviewPhase): number | null {
  if (phase === 'inventorying') return 30;
  if (phase === 'adjudicating') return 60;
  if (phase === 'matching') return 75;
  if (phase === 'conflict_check') return 85;
  if (phase === 'reviewing') return 90;
  if (phase === 'completed') return 100;
  return null;
}

/**
 * Keep the reader-facing claim label stricter than the model's raw verdict.
 * A supported claim must have a saved excerpt that the reader can inspect;
 * a source URL or a model verdict alone is not evidence.
 */
export function claimDisplayStatus(claim: ClaimEvidencePresentationInput): ClaimDisplayStatus {
  // An unsettled execution state is never allowed to inherit the model's raw
  // verdict. In particular, a timed-out batch must not look contradicted.
  if (claimJudgmentStatus(claim) !== 'settled') return 'unverified';
  const verdict = claim.verdict?.toLowerCase();
  if (verdict === 'contradicted' || verdict === 'conflict' || verdict === 'correctable') return 'contradicted';
  if (
    (verdict === 'supported' || verdict === 'verified' || verdict === 'pass')
    && claim.evidence?.excerpt?.trim()
  ) {
    return 'supported';
  }
  return 'unverified';
}

export function countClaimDisplayStatuses(claims: ClaimEvidencePresentationInput[]): Record<ClaimDisplayStatus, number> {
  return claims.reduce<Record<ClaimDisplayStatus, number>>((counts, claim) => {
    // Citation relationships and opinions are counted separately. They do
    // not represent unresolved factual statements.
    if (!claimIsFactual(claim)) return counts;
    counts[claimDisplayStatus(claim)] += 1;
    return counts;
  }, { supported: 0, unverified: 0, contradicted: 0 });
}
import { claimIsResearchProcessObservation } from './research-review-decisions';
