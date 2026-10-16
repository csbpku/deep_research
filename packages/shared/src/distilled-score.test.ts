import { describe, expect, it } from 'vitest';
import { DistilledScoreSchema } from './schemas';

const score = {
  total: 60, tier: 'deep_read',
  dimensions: {
    informationGain: 2, analysisDepth: 2, actionability: 1,
    factualReliability: 2, currentApplicability: 2, expressionQuality: 2, audienceFit: 2,
  },
  weakPoint: 'Limited replication evidence', veto: null, riskFlags: [],
  profile: 'paper', isDefault: false, version: '5.0',
};

describe('scoring text Unicode limits', () => {
  it.each([
    ['weakPoint', 100], ['weakPointEvidence', 120], ['relevanceEvidence', 240],
  ] as const)('preserves %s at its Python code-point boundary', (field, maximum) => {
    const evidence = 'a'.repeat(maximum - 1) + '𝓜';
    expect(evidence.length).toBe(maximum + 1);
    expect(DistilledScoreSchema.parse({ ...score, [field]: evidence })[field]).toBe(evidence);
    expect(DistilledScoreSchema.parse({ ...score, [field]: '𝓜'.repeat(maximum) })[field])
      .toBe('𝓜'.repeat(maximum));
  });

  it.each([
    ['weakPoint', 100], ['weakPointEvidence', 120], ['relevanceEvidence', 240],
  ] as const)('still rejects overlong %s without changing its value', (field, maximum) => {
    for (const evidence of ['a'.repeat(maximum + 1), '𝓜'.repeat(maximum) + 'a']) {
      const input: Record<string, unknown> = { ...score, [field]: evidence };
      expect(DistilledScoreSchema.safeParse(input).success).toBe(false);
      expect(input[field]).toBe(evidence);
    }
  });

  it('continues rejecting invalid scoring dimensions', () => {
    expect(DistilledScoreSchema.safeParse({
      ...score, dimensions: { ...score.dimensions, actionability: 4 },
    }).success).toBe(false);
  });
});
