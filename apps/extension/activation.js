export function activationReason(tab) {
  const rawUrl = typeof tab?.url === 'string' ? tab.url.trim() : '';
  // A missing URL is not evidence of a protected page. Chrome can redact tab
  // metadata briefly while a tab is resolving, or on an older browser.
  if (!rawUrl) return 'unknown';
  try {
    return /^https?:$/u.test(new URL(rawUrl).protocol) ? 'permission' : 'unsupported';
  } catch {
    return 'unknown';
  }
}
