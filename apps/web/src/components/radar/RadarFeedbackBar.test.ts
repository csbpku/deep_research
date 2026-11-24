import { createElement as h } from 'react';
import { renderToStaticMarkup as render } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { RadarFeedbackBar, type RadarFeedbackCounts } from './RadarFeedbackBar';

const counts: RadarFeedbackCounts = {
  favorite: 0, useful: 0, inaccurate: 0, used: 0, suggest_research: 0,
  read: 0, later: 0, pilot: 0,
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
    expect(html).toContain('aria-label="不感兴趣（0）"');
    expect(html).toMatch(/>0<\/span>/);
  });
});

describe('RadarFeedbackBar judgments', () => {
  it('renders the four primary judgment actions with Chinese labels', () => {
    const html = render(h(RadarFeedbackBar, {
      summaryId: 'summary-1', initialCounts: counts, initialMine: [],
      types: ['read', 'later', 'pilot', 'inaccurate'],
    }));
    expect(html).toContain('已读');
    expect(html).toContain('稍后');
    expect(html).toContain('值得试点');
    expect(html).toContain('不感兴趣');
    expect(html).not.toContain('点踩');
  });

  it('reflects an existing judgment as pressed without hiding its label', () => {
    const html = render(h(RadarFeedbackBar, {
      summaryId: 'summary-1',
      initialCounts: { ...counts, pilot: 1 },
      initialMine: ['pilot'],
      types: ['read', 'later', 'pilot', 'inaccurate'],
    }));
    expect(html).toContain('aria-label="值得试点（1）"');
    expect(html).toContain('aria-pressed="true"');
  });
});
