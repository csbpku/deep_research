import { describe, expect, it } from 'vitest';

import { resolveResearchSourceLink } from './research-source-link';

const ID = '11111111-1111-4111-8111-111111111111';

describe('resolveResearchSourceLink', () => {
  it('resolves external source formats', () => {
    expect(resolveResearchSourceLink({ type: 'url', value: 'https://example.com/a' })).toEqual({
      href: 'https://example.com/a',
      external: true,
    });
    expect(resolveResearchSourceLink({ type: 'doi', value: '10.1234/abc' })?.href)
      .toBe('https://doi.org/10.1234/abc');
    expect(resolveResearchSourceLink({ type: 'arxiv', value: '2501.12345' })?.href)
      .toBe('https://arxiv.org/abs/2501.12345');
  });

  it('resolves internal summary and research references', () => {
    expect(resolveResearchSourceLink({ type: 'summary', value: ID })).toEqual({
      href: `/radar/${ID}`,
      external: false,
    });
    expect(resolveResearchSourceLink({ type: 'research', value: ID })).toEqual({
      href: `/researches/${ID}`,
      external: false,
    });
  });

  it('falls back to a navigable canonical URL', () => {
    expect(resolveResearchSourceLink({ type: 'book', value: 'unknown' }, 'https://example.com/source'))
      .toEqual({ href: 'https://example.com/source', external: true });
  });

  it('rejects unsafe or malformed targets', () => {
    expect(resolveResearchSourceLink({ type: 'url', value: 'javascript:alert(1)' })).toBeNull();
    expect(resolveResearchSourceLink({ type: 'summary', value: 'not-an-id' })).toBeNull();
  });
});
