import React, { createElement as h } from 'react';
import { renderToStaticMarkup as render } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  query: vi.fn(),
  detail: null as Record<string, unknown> | null,
  exportedResearch: vi.fn(),
}));

vi.mock('@tanstack/react-query', () => ({
  useQuery: mocks.query,
  useQueryClient: () => ({ invalidateQueries: vi.fn() }),
}));
vi.mock('next/navigation', () => ({
  useParams: () => ({ id: '10000000-0000-4000-8000-000000000019' }),
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }),
  useSearchParams: () => new URLSearchParams(''),
}));
vi.mock('@/lib/auth/client', () => ({
  useCurrentUser: () => ({ data: { id: 'user-1', role: 'user' } }),
}));
vi.mock('@/components/CommentSection', () => ({
  CommentSection: () => h('div', { 'data-testid': 'comments' }),
}));
vi.mock('@/components/research/ExportResearchMarkdownButton', () => ({
  ExportResearchMarkdownButton: ({ research }: { research: unknown }) => {
    mocks.exportedResearch(research);
    return h('button', null, '导出 Markdown');
  },
}));

// 该页使用 JSX preserve + 经典 transform 渲染（Next 用 SWC，vitest 用 esbuild），
// 页面本身不引入 React 默认导出，这里补上 SSR 渲染所需的全局 React。
(globalThis as unknown as { React: typeof React }).React = React;

import ResearchDetailPage from './page';

function research(overrides: Record<string, unknown> = {}) {
  return {
    id: '10000000-0000-4000-8000-000000000019',
    type: 'research',
    status: 'published',
    title: '结果页重排回归',
    body: '正文说明。',
    background: '背景说明。',
    conclusion: '结论说明。',
    risks: '风险说明。',
    tags: ['RAG 与检索'],
    authorId: 'author-1',
    creationMethod: 'ai_research',
    aiAssisted: false,
    publishedAt: '2026-10-19T00:00:00Z',
    featuredAt: '2026-10-19T00:00:00Z',
    createdAt: '2026-10-19T00:00:00Z',
    updatedAt: '2026-10-19T00:00:00Z',
    author: { id: 'author-1', name: '测试作者' },
    canEdit: false,
    canManageStatus: false,
    researchSources: [],
    researchTopics: [],
    sourceComment: null,
    commentCount: 0,
    audits: [],
    reviewVerification: null,
    reviewDisclosureSummary: null,
    reviewDisclosure: [],
    ...overrides,
  };
}

function headingIndex(html: string, title: string) {
  return html.indexOf(`${title}</h2>`);
}

beforeEach(() => {
  mocks.exportedResearch.mockClear();
  mocks.query.mockReset();
  mocks.query.mockImplementation((options: { queryKey: unknown[] }) => {
    if (options.queryKey[0] === 'current-user') {
      return { data: { id: 'user-1', role: 'user' } };
    }
    return {
      data: mocks.detail,
      isLoading: false,
      isError: false,
      error: null,
      refetch: vi.fn(),
    };
  });
});

describe('research result page reading order (P0-8)', () => {
  it('shows high-risk re-verification findings and passes the same disclosure to the download', () => {
    const disclosure = [{ claimId: 'danger', claim: '需要修订的结论', label: '来源存在冲突', evidenceStatus: 'contradicted', reason: '此前作者接受的理由' }];
    const summary = { coverageStatus: 'complete', researchSufficiencyStatus: 'sufficient', openCount: 1,
      unsupportedCount: 0, conflictCount: 1, highRiskOpenCount: 1, hardBlockCount: 1,
      disclosedCount: 0, machineIncomplete: true, reviewStatus: 'review_unavailable', retainedPreviousRisks: true };
    mocks.detail = research({ reviewVerification: 'conflicted', reviewDisclosure: disclosure, reviewDisclosureSummary: summary });
    const html = render(h(ResearchDetailPage));
    expect(html).toContain('核验存在冲突');
    expect(html).toContain('核验发现高风险来源冲突');
    expect(html).toContain('最新自动核验尚未完成');
    expect(html).toContain('此前作者接受的理由');
    expect(mocks.exportedResearch).toHaveBeenCalledWith(expect.objectContaining({
      reviewVerification: 'conflicted', reviewDisclosure: disclosure, reviewDisclosureSummary: summary,
    }));
  });
  it('reads 结论 → 正文 → 证据 → 审查 and keeps disclosure/audit in one collapsed panel', () => {
    mocks.detail = research({
      researchSources: [
        {
          id: 'source-1',
          sourceRef: { type: 'url', value: 'https://example.com/evidence' },
          canonicalKey: 'https://example.com/evidence',
          title: '证据原文',
          description: '来源摘要',
        },
      ],
      reviewDisclosureSummary: {
        coverageStatus: 'partial',
        researchSufficiencyStatus: 'sufficient',
        openCount: 1,
        unsupportedCount: 0,
        conflictCount: 0,
        highRiskOpenCount: 0,
        disclosedCount: 0,
        machineIncomplete: false,
      },
      reviewDisclosure: [
        { claimId: 'claim-1', claim: '待核验声明内容', action: 'disclose', label: '待核验', reason: '缺一手来源', evidenceStatus: 'open' },
      ],
      audits: [
        { id: 'audit-1', action: 'edit', editor: { name: '审核员' }, createdAt: '2026-10-19T00:00:00Z', diff: { body: true } },
      ],
    });

    const html = render(h(ResearchDetailPage));

    const order = [
      '核验与披露',
      '研究摘要',
      '结论',
      '背景',
      '风险与待验证项',
      '正文',
      '来源与证据',
      '团队讨论',
    ].map((title) => headingIndex(html, title));
    // 折叠区标题是 summary 内的 span，不是 h2。
    order.push(html.indexOf('审查与元数据'));
    expect(order.every((index) => index >= 0)).toBe(true);
    expect(order).toEqual([...order].sort((a, b) => a - b));

    // 只保留一个折叠区，默认收起，且披露明细不重复出现在顶部横幅。
    expect(html.match(/<details/gu) ?? []).toHaveLength(1);
    expect(html).toContain('id="review-audit"');
    expect(html.match(/<details[^>]*\sopen/gu)).toBeNull();
    expect(html.split('待核验声明内容')).toHaveLength(2);

    // 折叠区仍保留原始元数据与修改历史。
    expect(html).toContain('修改历史（1）');
    expect(html).toContain('审核员');
    expect(html).toContain('更新时间');
    // 主要操作不受重排影响。
    expect(html).toContain('导出 Markdown');
  });

  it('keeps knowledge cards in 结论 → 正文 → 来源评论 → 来源 order', () => {
    mocks.detail = research({
      type: 'knowledge',
      title: '知识卡片回归',
      sourceComment: {
        body: '来源评论内容',
        authorName: '评论作者',
        targetId: null,
        targetType: null,
        targetTitle: null,
      },
      researchSources: [
        {
          id: 'source-1',
          sourceRef: { type: 'url', value: 'https://example.com/evidence' },
          canonicalKey: 'https://example.com/evidence',
          title: '证据原文',
          description: null,
        },
      ],
    });

    const html = render(h(ResearchDetailPage));

    const order = ['结论', '背景', '风险与待验证项', '正文', '来源评论', '来源'].map((title) =>
      headingIndex(html, title),
    );
    expect(order.every((index) => index >= 0)).toBe(true);
    expect(order).toEqual([...order].sort((a, b) => a - b));
    expect(html).not.toContain('发布时披露');
  });
});
