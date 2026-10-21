export function getReaderInstallDownloadState(input: {
  signedIn: boolean;
  betaPath: string;
  betaUrl: string;
}): { available: boolean; action: 'download' | 'signin' | 'unavailable' } {
  const available = Boolean(input.betaPath || input.betaUrl);

  if (!available) return { available, action: 'unavailable' };
  return { available, action: input.signedIn ? 'download' : 'signin' };
}

export function safeReaderReturnUrl(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  try {
    const url = new URL(value);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return null;
    return url.toString();
  } catch {
    return null;
  }
}

export const READER_STORE_URL = 'https://chromewebstore.google.com/detail/bldpmkepljipbadeegednfinnilgoedl';

export function getReaderInstallHref(_sourceUrl: string): string {
  return READER_STORE_URL;
}
