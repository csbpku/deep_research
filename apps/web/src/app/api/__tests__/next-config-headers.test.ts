import { describe, expect, it } from 'vitest';
import config from '../../../../next.config';

describe('next.config headers()', () => {
  it('forbids cross-origin framing on every route', async () => {
    const rules = await config.headers!();
    expect(rules).toHaveLength(1);
    expect(rules[0]!.source).toBe('/:path*');
    const headers = Object.fromEntries(rules[0]!.headers.map((h) => [h.key, h.value]));
    expect(headers['Content-Security-Policy']).toBe("frame-ancestors 'self'");
    expect(headers['X-Frame-Options']).toBe('SAMEORIGIN');
  });
});
