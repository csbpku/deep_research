import { createElement as h, type ReactNode } from 'react';
import { renderToStaticMarkup as render } from 'react-dom/server';
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { ApiHttpError } from '@/lib/errors/api-error';

const mocks = vi.hoisted(() => ({
  query: vi.fn(),
  pathname: '/ai-research',
  refetch: vi.fn(),
}));

vi.mock('@tanstack/react-query', () => ({
  useQuery: mocks.query,
  useQueryClient: () => ({ invalidateQueries: vi.fn() }),
}));
vi.mock('next/navigation', () => ({
  usePathname: () => mocks.pathname,
  useRouter: () => ({ push: vi.fn() }),
}));
// Render drawer content without a portal so history states are inspectable in Node.
vi.mock('@/components/material/AppDrawer', () => ({
  AppDrawer: ({ children }: { children: ReactNode }) => h('section', null, children),
}));

import { RecentResearchArtifacts } from './RecentResearchArtifacts';
import { AiResearchConversationSidebar } from './AiResearchConversationSidebar';
import { AiResearchTaskHistory } from './AiResearchTaskHistory';
import { InlineAiResearchStatus } from './InlineAiResearchStatus';

interface QueryOptions {
  queryFn: () => Promise<unknown>;
  retry: (count: number, error: Error) => boolean;
  refetchOnMount: (query: { state: { error: Error } }) => boolean;
  refetchOnWindowFocus: (query: { state: { error: Error } }) => boolean;
  refetchOnReconnect: (query: { state: { error: Error } }) => boolean;
  refetchInterval?: (query: { state: { error: Error; data: unknown } }) => number | false;
}

function failWith(error: Error) {
  mocks.query.mockReturnValue({
    isLoading: false, isError: true, error, data: undefined, refetch: mocks.refetch,
  });
}

function options(): QueryOptions {
  return mocks.query.mock.calls[0][0] as QueryOptions;
}

const components = [
  { name: 'recent artifacts', renderComponent: () => render(h(RecentResearchArtifacts)), title: '登录后查看最近任务。' },
  { name: 'conversations', renderComponent: () => render(h(AiResearchConversationSidebar)), title: '登录后查看最近对话。' },
  { name: 'history', renderComponent: () => render(h(AiResearchTaskHistory)), title: '登录后查看历史任务。' },
];

beforeEach(() => {
  mocks.query.mockReset();
  mocks.refetch.mockReset();
  mocks.pathname = '/ai-research';
});
afterEach(() => vi.unstubAllGlobals());

describe.each(components)('$name authentication and failures', ({ renderComponent, title }) => {
  it('offers login with a callback, without an empty state or manual retry', () => {
    failWith(new ApiHttpError({ code: 'AUTH_NOT_AUTHENTICATED' }, 401, 'Unauthorized'));
    const html = renderComponent();
    expect(html).toContain(title);
    expect(html).toContain('/signin?callbackUrl=%2Fai-research');
    expect(html).not.toContain('重试');
    expect(html).not.toContain('还没有');
    expect(mocks.refetch).not.toHaveBeenCalled();
  });

  it('preserves HTTP status and stops retries and passive refetches for 401', async () => {
    failWith(new Error('initial'));
    renderComponent();
    const config = options();
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(
      JSON.stringify({ code: 'AUTH_NOT_AUTHENTICATED' }), { status: 401 },
    )));
    const error = await config.queryFn().catch((cause: unknown) => cause);
    expect(error).toBeInstanceOf(ApiHttpError);
    expect(error).toMatchObject({ status: 401, code: 'AUTH_NOT_AUTHENTICATED' });
    expect(config.retry(0, error as Error)).toBe(false);
    const query = { state: { error: error as Error } };
    expect(config.refetchOnMount(query)).toBe(false);
    expect(config.refetchOnWindowFocus(query)).toBe(false);
    expect(config.refetchOnReconnect(query)).toBe(false);
    if (config.refetchInterval) {
      expect(config.refetchInterval({
        state: { error: error as Error, data: { items: [{ status: 'running' }] } },
      })).toBe(false);
    }
  });

  it.each([403, 500, 503])('keeps HTTP %i visible as a real failure', (status) => {
    const error = new ApiHttpError({ code: status === 403 ? 'PERMISSION_DENIED' : 'INTERNAL' }, status, 'Failure');
    failWith(error);
    const html = renderComponent();
    expect(html).toContain('role="alert"');
    expect(html).toContain('重试');
    expect(html).not.toContain('/signin?');
    expect(options().retry(0, error)).toBe(status >= 500);
    expect(options().retry(1, error)).toBe(false);
  });

  it('retries a transient network failure once, without treating it as login', () => {
    const error = new TypeError('Failed to fetch');
    failWith(error);
    const html = renderComponent();
    expect(html).toContain('重试');
    expect(html).not.toContain('/signin?');
    expect(options().retry(0, error)).toBe(true);
    expect(options().retry(1, error)).toBe(false);
  });
});

describe('recent artifact content hierarchy', () => {
  const item = {
    jobId: 'job-1', topic: 'Compare storage engines', status: 'succeeded',
    currentStep: null, reportType: 'research_report', hasReport: true,
    reviewStatus: 'needs_action', capturedSourcesCount: 3, deliverableStatus: 'report',
    sourcePolicy: 'web', sourceRefs: [], draftResearchId: null,
    publishedResearchId: null, createdAt: null,
  };

  it('leads with the topic and result link while keeping the review gate visible', () => {
    mocks.query.mockReturnValue({ data: { items: [item] }, isLoading: false, isError: false });
    const html = render(h(RecentResearchArtifacts));
    expect(html).toContain('/ai-research/job-1');
    expect(html.indexOf('Compare storage engines')).toBeLessThan(html.indexOf('查看结果'));
    expect(html.indexOf('查看结果')).toBeLessThan(html.indexOf('需要确认'));
    expect(html).not.toContain('可以直接参考');
    expect(html).not.toContain('结论：');
  });

  it('does not promise a result when only evidence is available', () => {
    mocks.query.mockReturnValue({
      data: { items: [{ ...item, deliverableStatus: 'evidence_only', hasReport: false }] },
      isLoading: false, isError: false,
    });
    const html = render(h(RecentResearchArtifacts));
    expect(html).toContain('查看资料');
    expect(html).toContain('资料已保留');
    expect(html).not.toContain('查看结果');
  });

  it('keeps a blocked review visible after moving status below the topic', () => {
    mocks.query.mockReturnValue({
      data: { items: [{ ...item, reviewStatus: 'blocked' }] }, isLoading: false, isError: false,
    });
    const html = render(h(RecentResearchArtifacts));
    expect(html).toContain('需要修改');
    expect(html).not.toContain('可以直接参考');
  });
});

it('keeps the active conversation in the login callback', () => {
  failWith(new ApiHttpError({}, 401, 'Unauthorized'));
  const html = render(h(AiResearchConversationSidebar, { activeConversationId: 'conversation-1' }));
  expect(html).toContain('callbackUrl=%2Fai-research%3Fconversation%3Dconversation-1');
  expect(html).not.toContain('对话自动保存，可随时回来继续');
});

it('keeps the task detail path in the login callback', () => {
  mocks.pathname = '/ai-research/job-1';
  failWith(new ApiHttpError({}, 401, 'Unauthorized'));
  expect(render(h(AiResearchTaskHistory))).toContain('callbackUrl=%2Fai-research%2Fjob-1');
});

describe('inline research progress during a background read failure', () => {
  const data = {
    jobId: 'job-1', topic: 'Grok Bot research', status: 'running', finalStatus: null,
    currentStep: 'write', sourcesCount: 48, partialSourcesCount: 48, failedSourcesCount: 0,
    draftResearchId: null, reportType: 'research_report', outputText: null,
    errorCode: null, errorMessage: null, artifact: null, sources: [],
  };

  it('keeps the last successful snapshot visible on a transient error', () => {
    mocks.query.mockReturnValue({ data, isLoading: false, isError: true, error: new Error('temporary read timeout') });
    const html = render(h(InlineAiResearchStatus, { jobId: data.jobId }));
    expect(html).toContain('Grok Bot research');
    expect(html).toContain('最近一次状态');
    expect(html).not.toContain('调研状态暂时不可读');
  });

  it.each([401, 403, 404])('does not retain cached content after access is denied (%s)', (status) => {
    mocks.query.mockReturnValue({ data, isLoading: false, isError: true, error: new ApiHttpError({}, status, 'denied') });
    const html = render(h(InlineAiResearchStatus, { jobId: data.jobId }));
    expect(html).not.toContain('Grok Bot research');
    expect(html).toContain('调研状态暂时不可读');
  });
});


describe('quick-brief evidence profile', () => {
  it('shows model-only output without promoting a runtime planning context count to fetched evidence', () => {
    mocks.query.mockReturnValue({ isLoading: false, isError: false, data: {
      jobId: 'quick-1', topic: 'Quick direction', status: 'succeeded', finalStatus: 'succeeded', currentStep: 'write',
      reportType: 'summary_brief', reportLength: 'brief', partialSourcesCount: 1, capturedSourcesCount: 0,
      sourcesCount: 1, savedSourcesCount: 0, failedSourcesCount: 0, draftResearchId: null,
      outputText: 'A model-only direction', artifact: { type: 'markdown', title: 'Quick direction', content: 'A model-only direction' },
      deliverableStatus: 'report', review: null, researchProgress: { sourcesCaptured: 1 }, sources: [],
    } });
    const html = render(h(InlineAiResearchStatus, { jobId: 'quick-1' }));
    expect(html).toContain('仅模型摘录');
    expect(html).not.toContain('已抓取正文');
    expect(html).not.toContain('资料已保留');
    expect(html).toContain('不做完整检索或逐条核验');
  });

  it('retains real captured evidence on a quick brief without calling it verified research', () => {
    mocks.query.mockReturnValue({ isLoading: false, isError: false, data: {
      jobId: 'quick-2', topic: 'Quick evidence', status: 'succeeded', finalStatus: 'succeeded', currentStep: 'write',
      reportType: 'summary_brief', reportLength: 'brief', partialSourcesCount: 2, capturedSourcesCount: 1,
      sourcesCount: 2, savedSourcesCount: 1, failedSourcesCount: 0, draftResearchId: null,
      outputText: 'A quick direction', artifact: { type: 'markdown', title: 'Quick evidence', content: 'A quick direction' },
      deliverableStatus: 'report', review: null, researchProgress: { sourcesCaptured: 2 },
      sources: [{ id: 'real', title: 'Official source', snippet: 'Captured text.', href: 'https://docs.python.org/3/', type: 'url' }],
    } });
    const html = render(h(InlineAiResearchStatus, { jobId: 'quick-2' }));
    expect(html).toContain('快速判断已生成');
    expect(html).toContain('不做完整检索或逐条核验');
    expect(html).not.toContain('可以直接参考');
  });
});
