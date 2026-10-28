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


it('hashes the shared Unicode source snapshot vector', async () => {
  const { hashResearchSourceSnapshot } = await import('./research-evidence-task');
  expect(hashResearchSourceSnapshot([
    { canonicalKey: 'https://z.example', sourceRef: { value: 'https://z.example', type: 'url' }, title: '中文💡', description: '证据💡' },
    { canonicalKey: 'https://a.example', sourceRef: { type: 'url', value: 'https://a.example' }, title: 'Alpha', description: null },
  ])).toBe('15d7ce403e96c052eeaad46f85e1fbc2feb523cb87ebba124cfffcb27473cc08');
});
