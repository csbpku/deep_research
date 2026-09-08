export const ZREAD_SAMPLE_URL = 'https://github.com/deepseek-ai/deepseek-harness';

/** Repo reading mode is intentionally limited to GitHub repositories. */
export function isZreadRepository(url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.hostname === 'github.com' && !parsed.searchParams.has('digest');
  } catch {
    return false;
  }
}
