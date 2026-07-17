import { describe, expect, it } from 'vitest';

import { ERROR_CODES } from './errors.js';

describe('ERROR_CODES', () => {
  it('uses stable unique string values matching each key', () => {
    const entries = Object.entries(ERROR_CODES);
    expect(new Set(entries.map(([, value]) => value)).size).toBe(entries.length);
    for (const [key, value] of entries) {
      expect(value).toBe(key);
    }
  });
});
