import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { RadarRightPanel } from './RadarRightPanel';

describe('RadarRightPanel', () => {
  it('uses a source-only outline surface for skim candidates', () => {
    const html = renderToStaticMarkup(createElement(RadarRightPanel, {
      summaryId: '11111111-1111-4111-8111-111111111111',
      sourceOnly: true,
      sourceOutline: [{ heading: '来源章节', level: 2 }],
    }));

    expect(html).toContain('来源大纲');
    expect(html).toContain('来源章节');
    expect(html).not.toContain('文章地图');
    expect(html).not.toContain('AI 文章地图');
  });

  it('renders an annotations-only surface without an article map', () => {
    const html = renderToStaticMarkup(createElement(RadarRightPanel, {
      summaryId: '11111111-1111-4111-8111-111111111111',
      annotationsOnly: true,
    }));

    expect(html).toContain('我的批注');
    expect(html).toContain('还没有批注');
    expect(html).not.toContain('文章地图');
    expect(html).not.toContain('来源大纲');
  });
});
