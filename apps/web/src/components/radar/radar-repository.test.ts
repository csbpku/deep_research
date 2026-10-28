import { describe, expect, it } from 'vitest';

import { effectiveOriginalKind } from './radar-repository';

describe('effectiveOriginalKind', () => {
  it('recognises GitHub repository roots', () => {
    expect(effectiveOriginalKind(null, 'https://github.com/microsoft/markitdown'))
      .toBe('github_repo');
    expect(effectiveOriginalKind(null, 'https://github.com/volotat/mini-AGI/'))
      .toBe('github_repo');
    expect(effectiveOriginalKind(null, 'https://github.com/volotat/mini-AGI.git'))
      .toBe('github_repo');
  });

  it('separates issues, pull requests and releases', () => {
    expect(effectiveOriginalKind(null, 'https://github.com/owner/repo/issues/12'))
      .toBe('github_issue');
    expect(effectiveOriginalKind(null, 'https://github.com/owner/repo/pull/7'))
      .toBe('github_pr');
    expect(effectiveOriginalKind(null, 'https://github.com/owner/repo/releases/tag/v1.0'))
      .toBe('github_release');
    expect(effectiveOriginalKind(null, 'https://github.com/owner/repo/tree/main'))
      .toBe('github_other');
  });

  it('keeps the stored label authoritative', () => {
    expect(effectiveOriginalKind('rss', 'https://github.com/owner/repo')).toBe('rss');
    expect(effectiveOriginalKind('github_repo', 'https://example.com/post'))
      .toBe('github_repo');
  });

  it('returns null when the URL identifies no shape', () => {
    expect(effectiveOriginalKind(null, 'https://example.com/post')).toBeNull();
    expect(effectiveOriginalKind(null, 'not a url')).toBeNull();
    expect(effectiveOriginalKind(null, null)).toBeNull();
  });
});
