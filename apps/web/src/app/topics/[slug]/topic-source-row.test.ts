import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { SourceRow } from './TopicDetailTabs';

describe('topic source row', () => {
  it('hides evidence metadata while keeping reader-facing tags', () => {
    const html = renderToStaticMarkup(createElement(SourceRow, {
      candidate: {
        summaryId: 'summary-1',
        title: 'An article',
        url: 'https://example.com/article',
        originalKind: 'rss',
        tags: ['evidence_feed_excerpt', 'ai', 'engineering'],
        interpretation: 'A concise interpretation.',
        publishedAt: null,
      },
    }));

    expect(html).toContain('ai, engineering');
    expect(html).not.toContain('evidence_feed_excerpt');
    expect(html).toContain('/radar/summary-1');
  });
});
