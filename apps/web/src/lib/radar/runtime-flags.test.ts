import { describe, expect, it } from 'vitest';

import { radarEnrichmentEnabled } from './runtime-flags';

function env(overrides: Record<string, string> = {}): NodeJS.ProcessEnv {
  return { NODE_ENV: 'test', ...overrides };
}

describe('radarEnrichmentEnabled', () => {
  it('pauses enrichment by default', () => {
    expect(radarEnrichmentEnabled(env())).toBe(false);
  });

  it('pauses enrichment in browser reading mode', () => {
    expect(radarEnrichmentEnabled(env({ RADAR_READING_MODE: 'browser' }))).toBe(false);
    expect(radarEnrichmentEnabled(env({ RADAR_READING_MODE: 'external' }))).toBe(false);
  });

  it('honors an explicit pause flag', () => {
    expect(radarEnrichmentEnabled(env({
      RADAR_READING_MODE: 'enriched',
      RADAR_ENRICHMENT_ENABLED: '0',
    }))).toBe(false);
  });

  it('requires an explicit enriched mode or enable flag to resume', () => {
    expect(radarEnrichmentEnabled(env({ RADAR_READING_MODE: 'enriched' }))).toBe(true);
    expect(radarEnrichmentEnabled(env({ RADAR_ENRICHMENT_ENABLED: '1' }))).toBe(true);
  });
});
