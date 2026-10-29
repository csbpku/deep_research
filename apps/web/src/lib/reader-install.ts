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
export const READER_PENDING_INSTALL_KEY = 'dr:reader-pending-install';

export function rememberReaderInstall(sourceUrl: string): boolean {
  const source = safeReaderReturnUrl(sourceUrl);
  if (!source) return false;
  try {
    const url = new URL(source);
    url.searchParams.set('deep-research-platform', window.location.origin);
    window.sessionStorage.setItem(READER_PENDING_INSTALL_KEY, JSON.stringify({
      id: crypto.randomUUID(), url: url.toString(), createdAt: Date.now(), status: 'pending',
    }));
    return true;
  } catch { return false; }
}

export function clearReaderInstall(): void {
  try { window.sessionStorage.removeItem(READER_PENDING_INSTALL_KEY); } catch { /* storage unavailable */ }
}

export function getReaderInstallHref(_sourceUrl: string): string {
  return READER_STORE_URL;
}

const READER_PROMPT_DISMISSED_KEY = 'dr:reader-prompt-dismissed';

/**
 * "打开原文"是直链，Reader 安装提示只在用户明确要走 Reader 时出现。
 * 用户拒绝过一次就记住这个选择，不再每篇文章都问一遍。
 */
export function isReaderPromptDismissed(): boolean {
  try {
    if (typeof window === 'undefined' || !window.localStorage) return false;
    return window.localStorage.getItem(READER_PROMPT_DISMISSED_KEY) === '1';
  } catch {
    return false;
  }
}

export function dismissReaderPrompt(): void {
  try {
    if (typeof window === 'undefined' || !window.localStorage) return;
    window.localStorage.setItem(READER_PROMPT_DISMISSED_KEY, '1');
  } catch {
    // 存储不可用时退化为每次都提示，不阻塞阅读。
  }
}
