import { createElement as h } from 'react';
import { renderToStaticMarkup as render } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiHttpError } from '@/lib/errors/api-error';

const mocks = vi.hoisted(() => ({ query: vi.fn(), search: 'tab=draft', refetch: vi.fn() }));
vi.mock('@tanstack/react-query', () => ({
  useQuery: mocks.query,
  useQueryClient: () => ({ invalidateQueries: vi.fn() }),
}));
vi.mock('next/navigation', () => ({
  useRouter: () => ({ replace: vi.fn() }),
  useSearchParams: () => new URLSearchParams(mocks.search),
}));

import ResearchesPage from './page';

interface QueryOptions {
  queryKey: unknown[];
  queryFn: () => Promise<unknown>;
  retry: (count: number, error: Error) => boolean;
  refetchOnMount: (query: { state: { error: Error } }) => boolean;
  refetchOnWindowFocus: (query: { state: { error: Error } }) => boolean;
  refetchOnReconnect: (query: { state: { error: Error } }) => boolean;
}

function failWith(error: Error) {
  mocks.query.mockReturnValue({
    isLoading: false, isError: true, isFetching: false, error,
    data: undefined, refetch: mocks.refetch,
  });
}

beforeEach(() => {
  mocks.query.mockReset();
  mocks.refetch.mockReset();
  mocks.search = 'tab=draft';
  vi.stubGlobal('window', { setTimeout, clearTimeout });
});
afterEach(() => vi.unstubAllGlobals());

describe('research library authentication', () => {
  it.each(['', 'tab=draft', 'tab=mine'])('offers login for 401 and preserves query "%s"', (search) => {
    mocks.search = search;
    failWith(new ApiHttpError({}, 401, 'Unauthorized'));
    const html = render(h(ResearchesPage));
    const callbackUrl = `/researches${search ? `?${search}` : ''}`;
    expect(html).toContain(`/signin?${new URLSearchParams({ callbackUrl })}`);
    expect(html).toContain('登录后查看研究库。');
    expect(html).not.toContain('研究库暂时无法加载');
    expect(html).not.toContain('重试');
    expect(html).not.toContain('暂无草稿');
  });

  it('preserves HTTP errors and disables 401 retries and passive refetches', async () => {
    failWith(new ApiHttpError({}, 401, 'Unauthorized'));
    render(h(ResearchesPage));
    const config = mocks.query.mock.calls[0][0] as QueryOptions;
    const fetchMock = vi.fn().mockResolvedValue(new Response(
      JSON.stringify({ code: 'AUTH_NOT_AUTHENTICATED' }), { status: 401 },
    ));
    vi.stubGlobal('fetch', fetchMock);
    const error = await config.queryFn().catch((cause: unknown) => cause);
    expect(fetchMock.mock.calls[0][0]).toContain('scope=draft');
    expect(error).toBeInstanceOf(ApiHttpError);
    expect(error).toMatchObject({ status: 401 });
    expect(config.retry(0, error as Error)).toBe(false);
    const query = { state: { error: error as Error } };
    expect(config.refetchOnMount(query)).toBe(false);
    expect(config.refetchOnWindowFocus(query)).toBe(false);
    expect(config.refetchOnReconnect(query)).toBe(false);
  });

  it('does not render stale cached results after a 401', () => {
    mocks.query.mockReturnValue({
      isLoading: false, isError: true, isFetching: false,
      error: new ApiHttpError({}, 401, 'Unauthorized'), refetch: mocks.refetch,
      data: {
        items: [{
          id: 'cached', title: 'Cached private draft', body: 'Private content',
          tags: [], status: 'draft', createdAt: '2026-10-20', updatedAt: '2026-10-20',
          author: { id: 'user-1', name: 'Author' },
        }],
        totalPages: 1,
      },
    });
    const html = render(h(ResearchesPage));
    expect(html).toContain('登录后查看研究库。');
    expect(html).not.toContain('Cached private draft');
    expect(html).not.toContain('Private content');
  });

  it.each([403, 500, 503])('keeps HTTP %i as an actionable failure', (status) => {
    const error = new ApiHttpError({}, status, '研究库暂时无法读取。');
    failWith(error);
    const html = render(h(ResearchesPage));
    expect(html).toContain('研究库暂时无法加载');
    expect(html).toContain('重试');
    expect(html).not.toContain('/signin?');
    const config = mocks.query.mock.calls[0][0] as QueryOptions;
    expect(config.retry(0, error)).toBe(status >= 500);
    expect(config.retry(1, error)).toBe(false);
  });

  it('retains a retry path for network failures', () => {
    const error = new TypeError('Failed to fetch');
    failWith(error);
    const html = render(h(ResearchesPage));
    expect(html).toContain('研究库暂时无法加载');
    expect(html).toContain('重试');
    expect(html).not.toContain('/signin?');
    const config = mocks.query.mock.calls[0][0] as QueryOptions;
    expect(config.retry(0, error)).toBe(true);
    expect(config.retry(1, error)).toBe(false);
  });

  it('sends the search query and the sort order to the server', async () => {
    failWith(new ApiHttpError({}, 401, 'Unauthorized'));
    render(h(ResearchesPage));
    const config = mocks.query.mock.calls[0][0] as QueryOptions;
    const fetchMock = vi.fn().mockResolvedValue(new Response(
      JSON.stringify({ items: [], page: 1, limit: 20, total: 0, totalPages: 0 }),
      { status: 200 },
    ));
    vi.stubGlobal('fetch', fetchMock);
    await config.queryFn();

    const requestUrl = String(fetchMock.mock.calls[0][0]);
    const params = new URL(requestUrl, 'http://localhost').searchParams;
    // 搜索与排序必须打到服务端；客户端只能重排当前页，那会让"没有匹配项"
    // 在第 21 条之后变成假象。
    expect(params.get('sort')).toBe('newest');
    expect(params.get('scope')).toBe('draft');
    expect(params.get('limit')).toBe('20');
  });
});
