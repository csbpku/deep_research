const BROWSER_READING_MODES = new Set(['browser', 'external', 'plugin']);
const TRUE_VALUES = new Set(['1', 'true', 'yes', 'on']);
const FALSE_VALUES = new Set(['0', 'false', 'no', 'off']);

export function radarEnrichmentEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const explicit = env.RADAR_ENRICHMENT_ENABLED?.trim().toLowerCase();
  if (explicit && TRUE_VALUES.has(explicit)) return true;
  if (explicit && FALSE_VALUES.has(explicit)) return false;
  return !BROWSER_READING_MODES.has((env.RADAR_READING_MODE ?? 'browser').trim().toLowerCase());
}

export function radarEnrichmentPauseReason(env: NodeJS.ProcessEnv = process.env): string {
  if (FALSE_VALUES.has(env.RADAR_ENRICHMENT_ENABLED?.trim().toLowerCase() ?? '')) {
    return 'RADAR_ENRICHMENT_ENABLED=0';
  }
  return 'RADAR_READING_MODE=browser';
}
