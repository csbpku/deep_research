export const DEFAULT_WEB_APP_URL = 'https://techradar.top';
export const LEGACY_LOCAL_WEB_APP_URL = 'http://localhost:3000';

export function normalizePlatformOrigin(value) {
  const input = String(value || '').trim();
  if (!input) return '';
  if (/^[a-z][a-z\d+.-]*:\/\//iu.test(input) && !/^https?:\/\//iu.test(input)) return '';

  try {
    const hasHttpScheme = /^https?:\/\//iu.test(input);
    const isLoopback = /^(localhost|127(?:\.\d{1,3}){3}|\[::1\])(?::|\/|$)/iu.test(input);
    const url = new URL(hasHttpScheme ? input : `${isLoopback ? 'http' : 'https'}://${input}`);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return '';
    if (url.username || url.password) return '';
    return url.origin;
  } catch {
    return '';
  }
}

export function resolvePlatformOrigin(configuredValue, hintedValue = '') {
  const configured = normalizePlatformOrigin(configuredValue);
  if (configured && configured !== LEGACY_LOCAL_WEB_APP_URL) return configured;
  return normalizePlatformOrigin(hintedValue) || DEFAULT_WEB_APP_URL;
}
