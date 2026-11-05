import { describe, expect, it } from 'vitest';
import { costCoverage, formatKnownCost } from './cost-coverage';

describe('cost coverage', () => {
  it('treats zero or missing cost with tokens as unpriced, not free', () => {
    const result = costCoverage([
      { inputTokens: 20, outputTokens: 5, costCents: null },
      { inputTokens: 10, outputTokens: 1, costCents: 0 },
      { inputTokens: 10, outputTokens: 1, costCents: 4 },
      { inputTokens: null, outputTokens: null, costCents: null },
    ]);
    expect(result).toEqual({ costReportedCalls: 1, costUnavailableCalls: 2 });
    expect(formatKnownCost(0, 2)).toBe('未记录');
    expect(formatKnownCost(4, 2)).toBe('$0.04');
  });
});
