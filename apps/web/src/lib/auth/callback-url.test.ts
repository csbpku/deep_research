import { describe, expect, it } from 'vitest';
import { safeInternalCallbackUrl } from './callback-url';

describe('safeInternalCallbackUrl', () => {
  it('preserves a same-origin path, query, and fragment', () => {
    expect(safeInternalCallbackUrl('/reading/connect?state=abc#finish'))
      .toBe('/reading/connect?state=abc#finish');
  });

  it.each([
    'https://evil.example/path',
    '//evil.example/path',
    '///evil.example/path',
    '/\\evil.example/path',
    'javascript:alert(1)',
    'researches',
  ])('rejects non-local callback %s', value => {
    expect(safeInternalCallbackUrl(value)).toBe('/');
  });

  it('defaults missing or empty callback paths to the home page', () => {
    expect(safeInternalCallbackUrl(null)).toBe('/');
    expect(safeInternalCallbackUrl('')).toBe('/');
  });
});
