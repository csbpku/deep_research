// AI 调研任务的纯函数工具(进度、步骤索引、终态判断)。
// 详情页和父页都依赖这套逻辑；放 lib 避免双份。

import { reviewProgress, type AiReviewPhase } from './ai-review-ui';

export const TERMINAL_STATUSES = new Set([
  'succeeded',
  'failed',
  'cancelled',
  'partial',
]);

export const STEP_ORDER = [
  'plan',
  'search',
  'compress',
  'analyze',
  'write',
] as const;
const IN_FLIGHT_STEP_PROGRESS = [10, 30, 50, 70, 85] as const;
export type StepKey = (typeof STEP_ORDER)[number];

export interface DeepResearchProgress {
  mode?: string;
  round?: number;
  rounds?: number;
  branchesCompleted?: number;
  branchesTotal?: number;
  totalBranchesCompleted?: number;
  totalBranches?: number;
  currentFocus?: string | null;
  /** Pages touched by the research tree, before the independent-source cap. */
  pagesVisited?: number;
  sourcesDiscovered?: number;
  sourcesCaptured?: number;
  sourceCoverage?: Record<string, {
    label: string;
    discovered: number;
    captured: number;
    requiredCaptured?: number;
    status: 'covered' | 'pending' | 'missing' | string;
  }>;
  /** The optional search-tree timebox was reached; synthesis used captured evidence. */
  collectionTimedOut?: boolean;
  collectionTimeboxSeconds?: number;
  coverageRepair?: {
    attempted: number;
    captured: number;
  };
  claimGapRepair?: {
    identified: number;
    attempted: number;
    resolved: number;
    remaining: number;
    state: 'pending' | 'repairing' | 'complete' | string;
  };
  reportWriteFallback?: {
    reason?: 'timeout' | 'empty_or_invalid' | string;
    timeoutSeconds?: number;
    recoveredFromCapturedEvidence?: boolean;
  };
  adaptive?: {
    minFollowupGroups?: number;
    maxFollowupGroups?: number;
    followupGroupsStarted?: number;
    followupGroupsCompleted?: number;
    stalledGroups?: number;
    stoppedEarly?: boolean;
    stopReason?: 'evidence_sufficient' | 'no_new_evidence' | 'followup_budget_reached' | string;
  };
  retrieval?: {
    selectedProvider?: string;
    fallbackProvider?: string;
    fallbackAttempts?: number;
    primarySkipped?: number;
    cacheHits?: number;
    selectionReason?: string;
    attempts: number;
    emptyResults: number;
    failed: number;
    retrievalDegraded: boolean;
    searchUnavailable: boolean;
    providers?: Record<string, {
      attempts: number;
      emptyResults: number;
      failed: number;
      lastStatus?: number;
    }>;
  };
  state?: string;
}

/** 取 step 在 5 步流水线中的索引；未知返回 -1。 */
export function stepIndex(step: string | null | undefined): number {
  if (!step) return -1;
  return (STEP_ORDER as readonly string[]).indexOf(step);
}

/** progressPct 输入的最小字段集(两个页面共用)。 */
export interface ProgressInput {
  status: string;
  finalStatus: string | null;
  currentStep: string | null;
  errorStage?: string | null;
  review?: { phase?: AiReviewPhase } | null;
  researchProgress?: DeepResearchProgress | null;
}

/**
 * 进度百分比(0–100)。
 *
 * 关键规则:
 *   - succeeded 终态 = 100
 *   - failed/partial/cancelled 终态 = 封顶到失败/最后完成步骤,不显示 100%
 *   - review 阶段走 ai-review-ui 的 reviewProgress(90/100)
 *   - queued = 5,运行中的当前步骤最多到 85%，只有真正完成才显示 100%
 *   - 其他未知状态 = 10
 */
export function progressPct(s: ProgressInput): number {
  // 列表接口只返回一个终态 `status`，详情接口同时返回 `finalStatus`。
  // 统一解析，避免历史侧栏把已经完成的任务显示成 10%。
  const terminalStatus = s.finalStatus ?? (TERMINAL_STATUSES.has(s.status) ? s.status : null);
  if (terminalStatus === 'succeeded') return 100;
  if (terminalStatus === 'partial') {
    const idx = stepIndex(s.currentStep ?? s.errorStage ?? null);
    // Partial means a usable but incomplete result. Keep a visible gap from
    // 100% so the status cannot be mistaken for a successful completion.
    return Math.min(95, Math.max(50, idx >= 0 ? (idx + 1) * 20 : 60));
  }
  if (terminalStatus === 'failed') {
    const idx = stepIndex(s.errorStage ?? s.currentStep ?? null);
    return idx >= 0 ? Math.max(5, (idx + 1) * 20 - 5) : 25;
  }
  if (terminalStatus === 'cancelled') {
    const idx = stepIndex(s.currentStep ?? s.errorStage ?? null);
    return idx >= 0 ? Math.min(80, idx * 20) : 10;
  }
  // A stale `reviewing` snapshot can survive a terminal transition. Resolve
  // terminal state first so review progress never turns a failed/partial job
  // into an apparent 90% or 100% completion.
  const reviewPct = reviewProgress(s.review?.phase);
  if (reviewPct !== null) return reviewPct;
  if (s.status === 'queued' || s.finalStatus === 'queued') return 5;
  const idx = stepIndex(s.currentStep ?? s.errorStage ?? null);
  if (
    s.researchProgress?.mode === 'deep'
    && s.currentStep === 'search'
    && s.researchProgress.state !== 'analyzing'
  ) {
    const completed = s.researchProgress.totalBranchesCompleted ?? s.researchProgress.branchesCompleted ?? 0;
    const total = s.researchProgress.totalBranches ?? s.researchProgress.branchesTotal ?? 0;
    if (total > 0) return Math.min(55, 30 + Math.round((Math.min(completed, total) / total) * 25));
    return 30;
  }
  if (idx >= 0) return IN_FLIGHT_STEP_PROGRESS[idx] ?? 10;
  return 10;
}

/** 简短终态标签(详情页 header / 卡片 caption 用)。 */
export function terminalCaption(s: ProgressInput): string {
  if (s.finalStatus === 'succeeded') return '完成进度';
  if (s.finalStatus === 'partial') return '部分完成';
  if (s.finalStatus === 'failed') {
    const idx = stepIndex(s.errorStage ?? s.currentStep ?? null);
    if (idx >= 0) return `中止于第 ${idx + 1} 步`;
    return '任务失败';
  }
  if (s.finalStatus === 'cancelled') return '任务已撤回';
  return '完成进度';
}
