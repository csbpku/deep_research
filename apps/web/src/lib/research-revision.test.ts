import { describe, expect, it } from 'vitest';

import { hashResearchRevision } from './research-revision';

describe('research revision identity', () => {
  const base = {
    title: '研究标题',
    body: '# 正文',
    background: '背景',
    conclusion: '结论',
    risks: '风险',
    tags: ['a', 'b'],
  };

  it('changes when any publishable field changes', () => {
    const original = hashResearchRevision(base);
    for (const field of ['title', 'body', 'background', 'conclusion', 'risks'] as const) {
      expect(hashResearchRevision({ ...base, [field]: `${base[field]}（修改）` })).not.toBe(original);
    }
    expect(hashResearchRevision({ ...base, tags: ['a', 'c'] })).not.toBe(original);
  });

  it('uses the same identity for equivalent complete snapshots', () => {
    expect(hashResearchRevision(base)).toBe(hashResearchRevision({ ...base }));
    expect(hashResearchRevision({ ...base, background: undefined })).toBe(originalHashWithoutBackground(base));
    expect(hashResearchRevision({ ...base, background: undefined })).not.toBe(hashResearchRevision(base));
  });
});

function originalHashWithoutBackground(base: {
  title: string;
  body: string;
  background: string;
  conclusion: string;
  risks: string;
  tags: string[];
}): string {
  return hashResearchRevision({ ...base, background: null });
}
