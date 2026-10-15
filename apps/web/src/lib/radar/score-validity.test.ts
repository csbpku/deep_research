import { describe, expect, it } from 'vitest';
import cases from '../../../../../packages/shared/fixtures/radar-public-scores.json';
import { hasPublicRadarScore } from './score-validity';

describe('public radar score contract', () => {
  for (const test of cases) {
    it(test.name, () => expect(hasPublicRadarScore(test.row)).toBe(test.expected));
  }
});
