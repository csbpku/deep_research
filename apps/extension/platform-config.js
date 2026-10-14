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

function isLoopbackOrigin(origin) {
  try {
    const { hostname } = new URL(origin);
    return hostname === 'localhost' || /^127(?:\.\d{1,3}){3}$/u.test(hostname) || hostname === '[::1]';
  } catch {
    return false;
  }
}

// A page-supplied platform hint (the `deep-research-platform` URL parameter) is
// untrusted. It is honoured only when it names the default platform, the
// origin the user already configured, or a loopback dev origin.
export function trustedPlatformHint(hintedValue, configuredValue = '') {
  const hinted = normalizePlatformOrigin(hintedValue);
  if (!hinted) return '';
  if (hinted === DEFAULT_WEB_APP_URL) return hinted;
  if (hinted === normalizePlatformOrigin(configuredValue)) return hinted;
  return isLoopbackOrigin(hinted) ? hinted : '';
}

// The reader token may only be sent to the origin it was issued for.
export function tokenBoundToOrigin(tokenOrigin, platformOrigin) {
  const bound = normalizePlatformOrigin(tokenOrigin) || DEFAULT_WEB_APP_URL;
  return bound === normalizePlatformOrigin(platformOrigin);
}
