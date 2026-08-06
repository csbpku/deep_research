export type AiReviewPhase = 'not_started' | 'reviewing' | 'completed';

export interface AiReviewPresentationInput {
  phase?: AiReviewPhase;
  status?: string;
}

export function reviewDisplayStatus(review: AiReviewPresentationInput | null): string {
  return review?.status ?? review?.phase ?? 'not_started';
}

export function reviewDisplayLabel(review: AiReviewPresentationInput | null): string {
  const labels: Record<string, string> = {
    passed: '已通过',
    needs_revision: '需要修订',
    blocked: '阻止发布',
    review_unavailable: '审核不可用',
    not_applicable: '不适用',
    not_started: '等待审核',
    reviewing: '审核中',
  };
  const status = reviewDisplayStatus(review);
  return labels[status] ?? status;
}

export function reviewProgress(phase?: AiReviewPhase): number | null {
  if (phase === 'reviewing') return 90;
  if (phase === 'completed') return 100;
  return null;
}
