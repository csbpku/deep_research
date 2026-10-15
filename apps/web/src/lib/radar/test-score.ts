// Shared complete fixture for visibility tests; never write placeholder scores.
import cases from '../../../../../packages/shared/fixtures/radar-public-scores.json';
export const validRadarScore = cases[0].row.distilledScore as Record<string, unknown>;
