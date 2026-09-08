import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { RadarDetailIntro } from './RadarDetailIntro';

const source = { short: 'Hugging Face', full: 'Hugging Face Daily Papers' };
const paper = { short: '研究论文', full: '研究论文' };

describe('RadarDetailIntro', () => {
  it('keeps long paper metadata collapsed on narrow screens', () => {
    const html = renderToStaticMarkup(createElement(RadarDetailIntro, {
      title: 'A paper title',
      discoverySource: source,
      contentKind: paper,
      summary: '先给读者一个可判断的摘要。',
      authorsLabel: '作者甲, 作者乙, 作者丙 等 12 人 · arXiv:2608.30428',
      dateLabel: '发布于 2026/8/31',
      coverageLabel: '正文覆盖：已抓取',
    }));

    expect(html).toContain('论文信息');
    expect(html).toContain('sm:hidden');
    expect(html).toContain('sm:block');
    expect(html).toContain('arXiv:2608.30428');
    expect(html).toContain('hidden shrink-0 sm:inline');
  });

  it('offers an explicit control when the mobile quick judgment may be truncated', () => {
    const html = renderToStaticMarkup(createElement(RadarDetailIntro, {
      title: 'A technical article',
      discoverySource: source,
      contentKind: { short: '技术文章', full: '技术文章' },
      summary: '这是一段足够长的快速判断，用来验证移动端截断后仍然给出完整内容入口，避免读者误以为这就是全部判断。它还需要覆盖来源背景、核心变化、适用范围、证据状态和可能的限制，让测试真正接近真实雷达内容。阅读者还需要知道这项变化影响谁、证据来自哪里、哪些结论仍然需要复核，以及下一步是否值得打开原文继续阅读。',
    }));

    expect(html).toContain('展开完整判断');
    expect(html).toContain('aria-controls="radar-detail-summary"');
    expect(html).toContain('line-clamp-4');
  });
});
