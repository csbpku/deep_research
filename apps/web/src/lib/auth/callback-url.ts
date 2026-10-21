const CALLBACK_ORIGIN = 'https://callback.invalid';

/** Accept only same-origin absolute paths, including their query and fragment. */
export function safeInternalCallbackUrl(value: string | null | undefined): string {
  if (!value?.startsWith('/') || value.startsWith('//')) return '/';

  try {
    const parsed = new URL(value, CALLBACK_ORIGIN);
    if (parsed.origin !== CALLBACK_ORIGIN) return '/';
    return `${parsed.pathname}${parsed.search}${parsed.hash}`;
  } catch {
    return '/';
  }
}
