import { describe, expect, it } from 'vitest';

import { extractRadarToc } from './RadarOriginalArticle';

describe('extractRadarToc', () => {
  it('keeps only primary paper headings so detailed subheadings do not overwhelm the reader', () => {
    const items = extractRadarToc([
      '# Abstract',
      '## Method',
      '### Data collection',
      '#### Dataset details',
      '##### Annotation protocol',
      '## Results',
    ], true);

    expect(items.map((item) => item.label)).toEqual([
      'Abstract',
      'Method',
      'Data collection',
      'Results',
    ]);
    expect(items.map((item) => item.level)).toEqual([1, 2, 3, 2]);
  });

  it('preserves the existing h2-h3 scope for non-paper articles', () => {
    const items = extractRadarToc([
      '# Source title',
      '## Introduction',
      '### Trade-offs',
      '#### Implementation detail',
    ]);

    expect(items.map((item) => item.label)).toEqual(['Introduction', 'Trade-offs']);
  });
});
