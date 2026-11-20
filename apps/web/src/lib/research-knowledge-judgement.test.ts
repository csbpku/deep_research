import { describe, expect, it } from 'vitest';
import { isJudgementDue, validateKnowledgeJudgement } from './research-knowledge-judgement';

const NOW = new Date('2026-11-17T00:00:00Z');

describe('knowledge judgement', () => {
  it('requires a claim, confidence, scope and a future review date', () => {
    const result = validateKnowledgeJudgement({}, NOW);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.missing).toEqual(['judgement', 'judgementConfidence', 'judgementScope', 'judgementReviewAt']);
  });

  it('accepts a complete judgement and normalises whitespace', () => {
    const result = validateKnowledgeJudgement({
      judgement: '  GitNexus  更适合跨仓库查调用关系。 ',
      judgementConfidence: 'medium',
      judgementScope: '仅限已建索引的仓库',
      judgementReviewAt: '2027-02-01',
    }, NOW);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.judgement).toBe('GitNexus 更适合跨仓库查调用关系。');
      expect(result.value.judgementConfidence).toBe('medium');
    }
  });

  it('rejects a past review date and an unknown confidence', () => {
    const past = validateKnowledgeJudgement({
      judgement: '这是一个足够长的判断。', judgementConfidence: 'certain', judgementScope: '范围', judgementReviewAt: '2020-01-01',
    }, NOW);
    expect(past.ok).toBe(false);
    if (!past.ok) expect(past.errors.join(' ')).toContain('低/中/高');
  });

  it('marks a judgement due once the review date passes', () => {
    expect(isJudgementDue('2026-11-16', NOW)).toBe(true);
    expect(isJudgementDue('2027-01-01', NOW)).toBe(false);
    expect(isJudgementDue(null, NOW)).toBe(false);
  });
});
