import { hashResearchRevision, type ResearchRevisionFields } from './research-revision';
import type { ReviewDecisionRecord, ReviewPublicationGate } from './research-review-decisions';

export type ReviewExecutionStatus = 'queued' | 'reviewing' | 'completed' | 'unavailable' | 'stale';
export type ReviewOutcome = 'clear' | 'attention' | 'blocked' | 'insufficient' | 'unavailable' | 'stale' | null;
export type CurrentReviewStatus =
  | 'not_started'
  | 'queued'
  | 'reviewing'
  | 'passed'
  | 'needs_action'
  | 'needs_revision'
  | 'blocked'
  | 'review_unavailable'
  | 'stale';

export interface ReviewRunState {
  id: string;
  revisionHash: string;
  sourceSnapshotHash?: string | null;
  policyVersion?: string | null;
  executionStatus: string;
  outcome: string | null;
  attempt: number;
  createdAt?: Date | string;
  startedAt?: Date | string | null;
  leaseExpiresAt?: Date | string | null;
  heartbeatAt?: Date | string | null;
  completedAt?: Date | string | null;
  summary?: unknown;
  claims?: unknown;
  details?: unknown;
  decisions?: ReviewDecisionRecord[] | null;
  publicationGate?: ReviewPublicationGate | null;
  triggeredBy?: string | null;
}

export interface CurrentReviewState<T extends ReviewRunState = ReviewRunState> {
  revisionHash: string;
  status: CurrentReviewStatus;
  outcome: ReviewOutcome;
  run: T | null;
  attempt: number;
  /** True only when the verdict is attached to the exact current snapshot. */
  isCurrentRevision: boolean;
  /** Compatibility mode is only allowed when the caller did not load runs. */
  isLegacyFallback: boolean;
}

function sortNewestFirst<T extends { createdAt?: Date | string }>(runs: T[]): T[] {
  return [...runs].sort((a, b) => {
    const left = a.createdAt ? new Date(a.createdAt).getTime() : 0;
    const right = b.createdAt ? new Date(b.createdAt).getTime() : 0;
    return right - left;
  });
}

function statusFromRun(run: ReviewRunState): CurrentReviewStatus {
  if (run.executionStatus === 'queued') return 'queued';
  if (run.executionStatus === 'reviewing') return 'reviewing';
  if (run.executionStatus === 'unavailable') return 'review_unavailable';
  if (run.executionStatus === 'stale') return 'stale';
  if (run.executionStatus === 'completed') {
    if (run.outcome === 'clear') return 'passed';
    if (run.outcome === 'blocked') return 'blocked';
    if (run.outcome === 'unavailable') return 'review_unavailable';
    if (run.outcome === 'attention' || run.outcome === 'insufficient') return 'needs_action';
    return 'needs_revision';
  }
  return 'stale';
}

/**
 * Resolve the only review state that may affect the current document.
 *
 * `reviewRuns` has three deliberately different meanings:
 * - undefined: an old caller did not load the new relation; legacy mirrors
 *   may be used for compatibility;
 * - []: the relation was loaded and this revision has never been reviewed;
 * - non-empty: history exists, but only an exact non-stale hash is current.
 *
 * Keeping this distinction here prevents a historical `passed` or `blocked`
 * mirror from being mistaken for a verdict on edited content.
 */
export function resolveCurrentReviewState<T extends ReviewRunState>(
  revision: ResearchRevisionFields,
  reviewRuns: T[] | undefined,
  legacyReviewStatus?: string | null,
): CurrentReviewState<T> {
  const revisionHash = hashResearchRevision(revision);
  const loadedRuns = Array.isArray(reviewRuns);
  const runs = loadedRuns ? sortNewestFirst(reviewRuns) : [];
  const currentRun = runs.find((run) => (
    run.revisionHash === revisionHash && run.executionStatus !== 'stale'
  )) ?? null;

  if (currentRun) {
    return {
      revisionHash,
      status: statusFromRun(currentRun),
      outcome: normalizeOutcome(currentRun.outcome),
      run: currentRun,
      attempt: currentRun.attempt,
      isCurrentRevision: true,
      isLegacyFallback: false,
    };
  }

  // This fallback is intentionally impossible once the caller loaded the
  // relation. In production that means a legacy mirror can never certify a
  // current revision without a corresponding version-scoped run.
  if (!loadedRuns && legacyReviewStatus === 'passed') {
    return {
      revisionHash,
      status: 'passed',
      outcome: 'clear',
      run: null,
      attempt: 0,
      isCurrentRevision: true,
      isLegacyFallback: true,
    };
  }

  if (loadedRuns && runs.length > 0) {
    return {
      revisionHash,
      status: 'stale',
      outcome: 'stale',
      run: null,
      attempt: 0,
      isCurrentRevision: false,
      isLegacyFallback: false,
    };
  }

  // Preserve useful legacy operational states for callers that have no run
  // history at all, but never let them pass the publication gate.
  const legacyStatus = legacyReviewStatus === 'queued'
    || legacyReviewStatus === 'reviewing'
    || legacyReviewStatus === 'review_unavailable'
    ? legacyReviewStatus
    : 'not_started';
  return {
    revisionHash,
    status: legacyStatus,
    outcome: legacyStatus === 'review_unavailable' ? 'unavailable' : null,
    run: null,
    attempt: 0,
    isCurrentRevision: false,
    isLegacyFallback: false,
  };
}

function normalizeOutcome(value: string | null): ReviewOutcome {
  return value === 'clear'
    || value === 'attention'
    || value === 'blocked'
    || value === 'insufficient'
    || value === 'unavailable'
    || value === 'stale'
    ? value
    : null;
}
