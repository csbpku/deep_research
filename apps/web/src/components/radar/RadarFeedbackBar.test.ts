import { createElement as h } from 'react';
import { renderToStaticMarkup as render } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { RadarFeedbackBar, type RadarFeedbackCounts } from './RadarFeedbackBar';

const counts: RadarFeedbackCounts = {
  favorite: 0, useful: 0, inaccurate: 0, used: 0, suggest_research: 0,
};

describe('RadarFeedbackBar favorite counts', () => {
  it('hides a zero favorite count but retains its accessible name and pressed state', () => {
    const html = render(h(RadarFeedbackBar, {
      summaryId: 'summary-1', initialCounts: counts, initialMine: [], types: ['favorite'],
    }));
    expect(html).toContain('aria-label="收藏（0）"');
    expect(html).toContain('aria-pressed="false"');
    expect(html).toContain('收藏');
    expect(html).not.toMatch(/>0<\/span>/);
  });

  it('shows a positive favorite count and the current selection', () => {
    const html = render(h(RadarFeedbackBar, {
      summaryId: 'summary-1', initialCounts: { ...counts, favorite: 3 },
      initialMine: ['favorite'], types: ['favorite'],
    }));
    expect(html).toContain('aria-label="收藏（3）"');
    expect(html).toContain('aria-pressed="true"');
    expect(html).toMatch(/>3<\/span>/);
  });

  it('does not change zero counts for other feedback types', () => {
    const html = render(h(RadarFeedbackBar, {
      summaryId: 'summary-1', initialCounts: counts, initialMine: [], types: ['inaccurate'],
    }));
    expect(html).toContain('aria-label="点踩（0）"');
    expect(html).toMatch(/>0<\/span>/);
  });
});
