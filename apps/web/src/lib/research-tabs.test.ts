import { describe, expect, it } from 'vitest';

import { parseResearchTab, researchTabHref } from './research-tabs';

describe('research tab URL contract', () => {
  it('accepts every supported tab', () => {
    expect(parseResearchTab('research')).toBe('research');
    expect(parseResearchTab('knowledge')).toBe('knowledge');
    expect(parseResearchTab('mine')).toBe('mine');
    expect(parseResearchTab('draft')).toBe('draft');
  });

  it('falls back to the public research tab for missing or unknown values', () => {
    expect(parseResearchTab(null)).toBe('research');
    expect(parseResearchTab('favorites')).toBe('research');
  });

  it('builds stable deep links', () => {
    expect(researchTabHref('research')).toBe('/researches');
    expect(researchTabHref('knowledge')).toBe('/researches?tab=knowledge');
    expect(researchTabHref('mine')).toBe('/researches?tab=mine');
    expect(researchTabHref('draft')).toBe('/researches?tab=draft');
  });
});
