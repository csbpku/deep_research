/** A knowledge card becomes reusable only when it states a claim, not just a
 *  reading note. These four fields are the minimum for that claim to be
 *  inspectable: what you assert, how sure you are, where it applies, and when
 *  to revisit it.
 */
export const JUDGEMENT_CONFIDENCES = ['low', 'medium', 'high'] as const;
export type JudgementConfidence = (typeof JUDGEMENT_CONFIDENCES)[number];

export const JUDGEMENT_CONFIDENCE_LABELS: Record<JudgementConfidence, string> = {
  low: '低',
  medium: '中',
  high: '高',
};

export interface KnowledgeJudgement {
  judgement: string;
  judgementConfidence: JudgementConfidence;
  judgementScope: string;
  judgementReviewAt: Date;
}

export interface KnowledgeJudgementInput {
  judgement?: string | null;
  judgementConfidence?: string | null;
  judgementScope?: string | null;
  judgementReviewAt?: string | Date | null;
}

export type KnowledgeJudgementResult =
  | { ok: true; value: KnowledgeJudgement }
  | { ok: false; missing: string[]; message: string; errors: string[] };

const MAX_JUDGEMENT = 500;
const MAX_SCOPE = 500;

function text(value: string | null | undefined): string {
  return (value ?? '').trim().replace(/\s+/gu, ' ');
}

export function validateKnowledgeJudgement(input: KnowledgeJudgementInput, now = new Date()): KnowledgeJudgementResult {
  const judgement = text(input.judgement);
  const scope = text(input.judgementScope);
  const confidence = input.judgementConfidence;
  const reviewAt = input.judgementReviewAt ? new Date(input.judgementReviewAt) : null;
  const missing: string[] = [];
  const errors: string[] = [];

  if (!judgement) missing.push('judgement');
  else if (judgement.length > MAX_JUDGEMENT) errors.push(`判断不能超过 ${MAX_JUDGEMENT} 字`);
  else if (!/[。！？.!?]$/u.test(judgement) && judgement.length < 8) errors.push('判断太短，请写成一句完整结论');

  if (!confidence) missing.push('judgementConfidence');
  else if (!JUDGEMENT_CONFIDENCES.includes(confidence as JudgementConfidence)) errors.push('置信度只能是低/中/高');

  if (!scope) missing.push('judgementScope');
  else if (scope.length > MAX_SCOPE) errors.push(`适用边界不能超过 ${MAX_SCOPE} 字`);

  if (!reviewAt) missing.push('judgementReviewAt');
  else if (Number.isNaN(reviewAt.getTime())) errors.push('复查时间无效');
  else if (reviewAt.getTime() <= now.getTime()) errors.push('复查时间必须晚于现在');

  if (missing.length > 0) {
    const labels: Record<string, string> = {
      judgement: '判断',
      judgementConfidence: '置信度',
      judgementScope: '适用边界',
      judgementReviewAt: '复查时间',
    };
    return {
      ok: false,
      missing,
      errors,
      message: `发布知识卡前需要补充：${missing.map(field => labels[field]).join('、')}`,
    };
  }
  if (errors.length > 0) return { ok: false, missing, errors, message: errors[0]! };

  return {
    ok: true,
    value: {
      judgement,
      judgementConfidence: confidence as JudgementConfidence,
      judgementScope: scope,
      judgementReviewAt: reviewAt as Date,
    },
  };
}

export function isJudgementDue(reviewAt: Date | string | null | undefined, now = new Date()): boolean {
  if (!reviewAt) return false;
  const at = new Date(reviewAt);
  return !Number.isNaN(at.getTime()) && at.getTime() <= now.getTime();
}
