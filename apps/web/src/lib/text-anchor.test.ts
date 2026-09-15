import { describe, expect, it, vi } from 'vitest';

import { sha256Hex } from './text-anchor';

describe('sha256Hex', () => {
  it('returns the standard SHA-256 digest on the native path', async () => {
    await expect(sha256Hex('')).resolves.toBe(
      'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    );
  });

  it('keeps the same digest when Web Crypto is unavailable on HTTP', async () => {
    vi.stubGlobal('crypto', undefined);

    await expect(sha256Hex('选择一段中文文本')).resolves.toBe(
      '1aee51d3a6c272ad036c474ffaf8383fa66f39eb173c0c73bf4318b8b474ad68',
    );
  });

  it('falls back when an insecure context exposes a non-callable or rejecting digest', async () => {
    vi.stubGlobal('crypto', { subtle: { digest: undefined } });
    await expect(sha256Hex('选择一段中文文本')).resolves.toBe(
      '1aee51d3a6c272ad036c474ffaf8383fa66f39eb173c0c73bf4318b8b474ad68',
    );

    vi.stubGlobal('crypto', { subtle: { digest: vi.fn().mockRejectedValue(new Error('SecurityError')) } });
    await expect(sha256Hex('选择一段中文文本')).resolves.toBe(
      '1aee51d3a6c272ad036c474ffaf8383fa66f39eb173c0c73bf4318b8b474ad68',
    );
  });
});
