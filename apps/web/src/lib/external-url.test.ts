import { describe, expect, it } from 'vitest';

import { isHttpUrl } from './external-url';

describe('isHttpUrl', () => {
  it.each(['https://example.com/a', 'http://localhost:3000/path'])('accepts %s', (url) => {
    expect(isHttpUrl(url)).toBe(true);
  });

  it.each(['digest://2026-08-05', 'javascript:alert(1)', '/relative', '', 'not a url'])(
    'rejects non-web target %s',
    (url) => {
      expect(isHttpUrl(url)).toBe(false);
    },
  );
});
