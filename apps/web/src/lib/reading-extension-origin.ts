export function isAllowedReadingRedirect(value: string): boolean {
  try {
    const url = new URL(value);
    if (url.protocol !== 'chrome-extension:' || url.pathname !== '/callback.html' || url.search || url.hash) return false;
    const configured = (process.env.READING_EXTENSION_IDS || '').split(',').map((item) => item.trim()).filter(Boolean);
    if (configured.length === 0) return process.env.NODE_ENV !== 'production';
    return configured.includes(url.hostname);
  } catch {
    return false;
  }
}

export function isAllowedReadingExtensionOrigin(value: string): boolean {
  try {
    const url = new URL(value);
    if (url.protocol !== 'chrome-extension:' || (url.pathname && url.pathname !== '/') || url.search || url.hash || url.username || url.password || url.port) return false;
    return isAllowedReadingRedirect(`chrome-extension://${url.hostname}/callback.html`);
  } catch {
    return false;
  }
}
