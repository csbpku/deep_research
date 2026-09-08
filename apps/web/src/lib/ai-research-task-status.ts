/**
 * User-facing status semantics for AI research task summaries.
 *
 * A worker reaching `succeeded` only proves that execution finished.  It does
 * not prove that the output has inspectable evidence.  Keep this distinction
 * in one place so the home page and history drawer cannot drift apart.
 */

import { researchUserStatus } from './research-user-status';

export interface AiResearchTaskStatusInput {
  status: string;
  reportType: string;
  hasReport: boolean;
  reviewStatus?: string | null;
  deliverableStatus?: 'report' | 'evidence_only' | 'none';
  capturedSourcesCount?: number;
  publishedResearchId?: string | null;
}

/** True only when the API explicitly reports zero captured evidence. */
export function isEvidenceFreeOutput(item: AiResearchTaskStatusInput): boolean {
  return item.status === 'succeeded'
    && item.hasReport
    && item.deliverableStatus !== 'evidence_only'
    && item.capturedSourcesCount === 0;
}

/** Use a warning tone for a successful-but-unverified output. */
export function taskStatusBadgeValue(item: AiResearchTaskStatusInput): string {
  if (item.status === 'succeeded' && item.reviewStatus === 'blocked') return 'failed';
  if (
    item.status === 'succeeded'
    && (item.reviewStatus === 'queued'
      || item.reviewStatus === 'reviewing'
      || item.reviewStatus === 'review_unavailable'
      || item.reviewStatus === 'needs_action'
      || item.reviewStatus === 'needs_revision')
  ) return 'partial';
  return isEvidenceFreeOutput(item) ? 'partial' : item.status;
}

export function taskStatusLabel(item: AiResearchTaskStatusInput): string {
  if (item.publishedResearchId) return '已发布';
  return researchUserStatus(item).label;
}
