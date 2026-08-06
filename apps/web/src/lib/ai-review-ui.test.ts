import { describe, expect, it } from 'vitest';
import { reviewDisplayLabel, reviewDisplayStatus, reviewProgress } from './ai-review-ui';

describe('AI review UI state', () => {
  it('keeps review separate from the generator status', () => {
    expect(reviewDisplayStatus({ phase: 'reviewing' })).toBe('reviewing');
    expect(reviewDisplayLabel({ phase: 'reviewing' })).toBe('审核中');
    expect(reviewProgress('reviewing')).toBe(90);
  });

  it('renders blocked as a publish gate, not success', () => {
    expect(reviewDisplayStatus({ phase: 'completed', status: 'blocked' })).toBe('blocked');
    expect(reviewDisplayLabel({ phase: 'completed', status: 'blocked' })).toBe('阻止发布');
    expect(reviewProgress('completed')).toBe(100);
  });

  it('does not claim an unavailable review passed', () => {
    expect(reviewDisplayLabel({ phase: 'completed', status: 'review_unavailable' })).toBe('审核不可用');
    expect(reviewDisplayLabel(null)).toBe('等待审核');
    expect(reviewProgress('not_started')).toBeNull();
  });

  it('labels non-research reports as not applicable', () => {
    expect(reviewDisplayLabel({ status: 'not_applicable' })).toBe('不适用');
  });
});
