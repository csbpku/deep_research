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
export type StepKey = (typeof STEP_ORDER)[number];

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
}

/**
 * 进度百分比(0–100)。
 *
 * 关键规则:
 *   - succeeded 终态 = 100
 *   - failed/partial/cancelled 终态 = 封顶到失败/最后完成步骤,不显示 100%
 *   - review 阶段走 ai-review-ui 的 reviewProgress(90/100)
 *   - queued = 5,其他未知状态 = 10
 */
export function progressPct(s: ProgressInput): number {
  const reviewPct = reviewProgress(s.review?.phase);
  if (reviewPct !== null) return reviewPct;
  if (s.finalStatus === 'succeeded') return 100;
  if (s.finalStatus === 'partial') {
    const idx = stepIndex(s.currentStep ?? s.errorStage ?? null);
    return Math.max(50, idx >= 0 ? (idx + 1) * 20 : 60);
  }
  if (s.finalStatus === 'failed') {
    const idx = stepIndex(s.errorStage ?? s.currentStep ?? null);
    return idx >= 0 ? Math.max(5, (idx + 1) * 20 - 5) : 25;
  }
  if (s.finalStatus === 'cancelled') {
    const idx = stepIndex(s.currentStep ?? s.errorStage ?? null);
    return idx >= 0 ? Math.min(80, idx * 20) : 10;
  }
  if (s.status === 'queued' || s.finalStatus === 'queued') return 5;
  const idx = stepIndex(s.currentStep ?? s.errorStage ?? null);
  if (idx >= 0) return (idx + 1) * 20;
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
