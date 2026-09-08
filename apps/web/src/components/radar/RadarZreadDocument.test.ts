import { createElement, type ComponentProps } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { RadarZreadDocument } from './RadarZreadDocument';

const baseProps: ComponentProps<typeof RadarZreadDocument> = {
  repositoryUrl: 'https://github.com/example/repo',
  leftColRef: { current: null },
  meta: {
    description: 'A small repository description.',
    defaultBranch: 'main',
    zread: {
      provider: 'zread-remote',
      status: 'complete',
      commitSha: 'abcdef123456',
      pages: [{ path: '1-overview.md', title: 'Overview', content: 'Project body.' }],
    },
  },
};

describe('RadarZreadDocument summary presentation', () => {
  it('shows a legacy one-line interpretation when no project summary exists', () => {
    const html = renderToStaticMarkup(createElement(RadarZreadDocument, {
      ...baseProps,
      aiBrief: '让 AI agent 像资深工程师一样思考。',
      projectSummary: null,
    }));

    expect(html).toContain('AI 一句话解读');
    expect(html).toContain('让 AI agent 像资深工程师一样思考。');
    expect(html).not.toContain('A small repository description.');
  });

  it('uses the repository description as a clearly labelled fallback', () => {
    const html = renderToStaticMarkup(createElement(RadarZreadDocument, {
      ...baseProps,
      aiBrief: null,
      projectSummary: null,
    }));

    expect(html).toContain('项目简介');
    expect(html).toContain('A small repository description.');
    expect(html).not.toContain('AI 一句话解读');
  });

  it('keeps distinct brief and project summary layers without duplicating them', () => {
    const html = renderToStaticMarkup(createElement(RadarZreadDocument, {
      ...baseProps,
      aiBrief: '为 AI coding agent 提供可验证的本地执行回执。',
      projectSummary: '这是一个多模型评审与发布质量控制工具。',
    }));

    expect(html).toContain('AI 一句话解读');
    expect(html).toContain('项目解读');
    expect(html).toContain('可验证的本地执行回执');
    expect(html).toContain('多模型评审');
  });

  it('treats a complete status with missing expected pages as partial cache', () => {
    const html = renderToStaticMarkup(createElement(RadarZreadDocument, {
      ...baseProps,
      meta: {
        ...baseProps.meta,
        zread: {
          ...baseProps.meta?.zread,
          status: 'complete',
          expectedPageCount: 2,
        },
      },
      showOverview: false,
    }));

    expect(html).toContain('当前项目文档为部分缓存（1/2 页）');
    expect(html).toContain('部分完成');
  });

  it('keeps the document refresh action visible when the detail intro owns the overview', () => {
    const html = renderToStaticMarkup(createElement(RadarZreadDocument, {
      ...baseProps,
      showOverview: false,
      onRefresh: () => undefined,
    }));

    expect(html).toContain('项目文档');
    expect(html).toContain('刷新文档');
  });
});
