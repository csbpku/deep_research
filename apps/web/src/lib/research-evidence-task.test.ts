import { describe, expect, it } from 'vitest';

import { hashResearchSourceSnapshot } from './research-evidence-task';

describe('claim-scoped evidence snapshots', () => {
  it('is stable regardless of source arrival order', () => {
    const first = hashResearchSourceSnapshot([
      { canonicalKey: 'https://example.com/b', sourceRef: { type: 'url', value: 'https://example.com/b' }, title: 'B', description: 'b' },
      { canonicalKey: 'https://example.com/a', sourceRef: { type: 'url', value: 'https://example.com/a' }, title: 'A', description: 'a' },
    ]);
    const second = hashResearchSourceSnapshot([
      { canonicalKey: 'https://example.com/a', sourceRef: { type: 'url', value: 'https://example.com/a' }, title: 'A', description: 'a' },
      { canonicalKey: 'https://example.com/b', sourceRef: { type: 'url', value: 'https://example.com/b' }, title: 'B', description: 'b' },
    ]);
    expect(first).toBe(second);
  });

  it('changes when the captured excerpt changes', () => {
    const original = hashResearchSourceSnapshot([
      { canonicalKey: 'https://example.com/a', sourceRef: { type: 'url', value: 'https://example.com/a' }, title: 'A', description: 'old excerpt' },
    ]);
    const refreshed = hashResearchSourceSnapshot([
      { canonicalKey: 'https://example.com/a', sourceRef: { type: 'url', value: 'https://example.com/a' }, title: 'A', description: 'new excerpt' },
    ]);
    expect(refreshed).not.toBe(original);
  });
});
