export const READER_PLATFORM_ORIGINS = new Set([
  'https://techradar.top',
  'https://www.techradar.top',
  'http://localhost:3000',
  'http://127.0.0.1:3000',
]);

export function getTrustedReaderPlatformOrigin(sender) {
  const value = typeof sender?.origin === 'string' && sender.origin !== 'null'
    ? sender.origin
    : sender?.url;
  if (typeof value !== 'string') return null;
  try {
    const origin = new URL(value).origin;
    return READER_PLATFORM_ORIGINS.has(origin) ? origin : null;
  } catch {
    return null;
  }
}

export function validateRadarSourceUrl(value, platformOrigin) {
  if (typeof value !== 'string' || !platformOrigin) return null;
  try {
    const url = new URL(value);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return null;
    if (url.searchParams.get('deep-research-source') !== 'radar') return null;
    if (!url.searchParams.get('deep-research-summary')?.trim()) return null;
    const platformHint = new URL(url.searchParams.get('deep-research-platform') || '');
    if (!['http:', 'https:'].includes(platformHint.protocol) || platformHint.origin !== platformOrigin) return null;
    return url.toString();
  } catch {
    return null;
  }
}
