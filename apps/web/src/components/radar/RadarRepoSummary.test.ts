import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { RadarRepoSummary } from './RadarRepoSummary';

const meta = { language: 'TypeScript', stars: 1200 };

describe('RadarRepoSummary', () => {
  it('keeps the legacy one-line interpretation visible when no project summary exists', () => {
    const html = renderToStaticMarkup(createElement(RadarRepoSummary, {
      brief: '让 AI agent 像资深工程师一样思考。',
      meta,
    }));

    expect(html).toContain('AI 一句话解读');
    expect(html).toContain('让 AI agent 像资深工程师一样思考。');
    expect(html).not.toContain('项目解读');
  });

  it('does not duplicate a brief already contained in the project summary', () => {
    const html = renderToStaticMarkup(createElement(RadarRepoSummary, {
      brief: 'Build reliable AI coding agents with a local verification receipt.',
      summary: 'Build reliable AI coding agents with a local verification receipt. The project stores evidence for every run.',
      meta,
    }));

    expect(html.match(/AI 一句话解读/gu)?.length ?? 0).toBe(0);
    expect(html).toContain('项目解读');
    expect(html).toContain('The project stores evidence for every run.');
  });

  it('shows distinct brief and project explanation as two different layers', () => {
    const html = renderToStaticMarkup(createElement(RadarRepoSummary, {
      brief: '为 AI coding agent 提供可验证的本地执行回执。',
      summary: 'Juror 是一个多模型评审与发布质量控制工具，覆盖配置、审核和计费流程。',
      meta,
    }));

    expect(html).toContain('AI 一句话解读');
    expect(html).toContain('项目解读');
    expect(html).toContain('可验证的本地执行回执');
    expect(html).toContain('多模型评审');
  });
});
