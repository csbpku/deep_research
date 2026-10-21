import { test, expect, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';

const refId = '10000000-0000-4000-8000-000000000001';
function result(q: string, type = 'radar', page = 1) {
  return {
    items: [{ id: `result-${type}-${page}`, type, refId, title: `${q}：第 ${page} 页的搜索结果`,
      snippet: '搜索结果摘要', highlighted: '这里包含 <mark>搜索高亮</mark> 和 &lt;script&gt;已转义文本&lt;/script&gt;。',
      publishedAt: '2026-10-16T00:00:00Z', rank: 1, isPrivate: type === 'knowledge' }],
    total: 21, page, per_page: 20, totalPages: 2,
  };
}
async function fixture(page: Page) {
  await page.route('**/api/search?*', route => {
    const params = new URL(route.request().url()).searchParams;
    return route.fulfill({ json: result(params.get('q') ?? '', params.get('type') || 'radar', Number(params.get('page') ?? 1)) });
  });
}

test.describe('MUI search contracts (read-only requests, no database writes)', () => {
  test.beforeEach(async ({ page }) => { await fixture(page); });

  test('empty search does not request results; native submit preserves highlights and API parameters', async ({ page }) => {
    const requests: URLSearchParams[] = [];
    page.on('request', request => {
      if (request.url().includes('/api/search?')) requests.push(new URL(request.url()).searchParams);
    });
    await page.goto('/search');
    await expect(page.getByRole('heading', { name: '开始搜索' })).toBeVisible();
    await expect(page.getByRole('button', { name: '搜索', exact: true })).toBeDisabled();
    expect(requests).toHaveLength(0);
    const input = page.getByRole('searchbox', { name: '搜索关键词' });
    await input.fill('  RAG 评估  ');
    await input.press('Enter');
    await expect(page).toHaveURL(/q=RAG\+%E8%AF%84%E4%BC%B0/);
    const article = page.getByRole('article');
    await expect(article.getByRole('heading', { name: 'RAG 评估：第 1 页的搜索结果' })).toBeVisible();
    await expect(article.locator('mark')).toHaveText('搜索高亮');
    await expect(article).toContainText('<script>已转义文本</script>');
    await expect(article.locator('script')).toHaveCount(0);
    expect(requests.at(-1)?.get('q')).toBe('RAG 评估');
    expect(requests.at(-1)?.get('type')).toBeNull();
    expect(requests.at(-1)?.get('page')).toBe('1');
    expect(requests.at(-1)?.get('per_page')).toBe('20');
  });

  test('keyboard tab activation keeps the committed query and unsubmitted input separate', async ({ page }) => {
    await page.goto('/search?q=committed&page=2');
    await expect(page.getByRole('heading', { name: 'committed：第 2 页的搜索结果' })).toBeVisible();
    const input = page.getByRole('searchbox', { name: '搜索关键词' });
    await input.fill('unsubmitted draft');
    await page.getByRole('tab', { name: '全部', exact: true }).focus();
    await page.keyboard.press('ArrowRight');
    const radar = page.getByRole('tab', { name: '雷达', exact: true });
    await expect(radar).toBeFocused();
    await expect(radar).toHaveAttribute('aria-selected', 'true');
    await expect(page.getByRole('tabpanel', { name: '雷达', exact: true })).toBeVisible();
    await expect.poll(() => new URL(page.url()).searchParams.get('type')).toBe('radar');
    expect(new URL(page.url()).searchParams.get('q')).toBe('committed');
    expect(new URL(page.url()).searchParams.get('page')).toBeNull();
    await expect(input).toHaveValue('unsubmitted draft');
    await expect(page.getByRole('heading', { name: 'committed：第 1 页的搜索结果' })).toBeVisible();
    await input.press('Enter');
    await expect(page.getByRole('heading', { name: 'unsubmitted draft：第 1 页的搜索结果' })).toBeVisible();
    await expect(page).toHaveURL(/type=radar/);
  });

  test('pagination, refresh and direct URL navigation keep type and detail return links', async ({ page }) => {
    await page.goto('/search?q=knowledge&type=knowledge');
    await expect(page.getByRole('article')).toContainText('本人草稿');
    await page.getByRole('button', { name: '下一页', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'knowledge：第 2 页的搜索结果' })).toBeVisible();
    await page.reload();
    await expect(page.getByRole('searchbox', { name: '搜索关键词' })).toHaveValue('knowledge');
    await expect(page.getByRole('tab', { name: '知识卡片', exact: true })).toHaveAttribute('aria-selected', 'true');
    const href = await page.getByRole('article').getByRole('link').getAttribute('href');
    const link = new URL(href!, page.url());
    expect(link.pathname).toBe(`/researches/${refId}`);
    expect(link.searchParams.get('returnTo')).toBe('/search?q=knowledge&type=knowledge&page=2');
    await page.goto('/search?q=next&type=summary');
    await expect(page.getByRole('searchbox', { name: '搜索关键词' })).toHaveValue('next');
    await expect(page.getByRole('heading', { name: 'next：第 1 页的搜索结果' })).toBeVisible();
    await expect(page.getByRole('tab', { name: '摘要', exact: true })).toHaveAttribute('aria-selected', 'true');
  });

  test('request errors retain query and type and retry through the original API', async ({ page }) => {
    let fail = true;
    await page.route('**/api/search?*', route => route.fulfill(fail
      ? { status: 503, json: { message: '搜索服务暂时不可用' } }
      : { json: result('retry', 'long_research') }));
    await page.goto('/search?q=retry&type=long_research');
    // Next's route announcer also has role=alert; assert the search panel's error.
    const searchError = page.getByRole('tabpanel', { name: '研究报告' }).getByRole('alert');
    await expect(searchError).toContainText('搜索服务暂时不可用');
    await expect(page.getByRole('searchbox', { name: '搜索关键词' })).toHaveValue('retry');
    await expect(page.getByRole('tab', { name: '研究报告', exact: true })).toHaveAttribute('aria-selected', 'true');
    fail = false;
    await page.getByRole('button', { name: '重试', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'retry：第 1 页的搜索结果' })).toBeVisible();
    await expect(searchError).not.toBeVisible();
  });

  test('loading removes stale rows and an obsolete type response cannot replace current results', async ({ page }) => {
    let release: () => void = () => undefined;
    const hold = new Promise<void>(resolve => { release = resolve; });
    let entered = false;
    await page.route('**/api/search?*', async route => {
      const type = new URL(route.request().url()).searchParams.get('type');
      if (type === 'long_research') { entered = true; await hold; }
      await route.fulfill({ json: result('race', type || 'radar') }).catch(() => undefined);
    });
    try {
      await page.goto('/search?q=race');
      await expect(page.getByRole('article')).toBeVisible();
      await page.getByRole('tab', { name: '研究报告', exact: true }).click();
      await expect.poll(() => entered).toBe(true);
      await expect(page.getByRole('status', { name: '正在搜索', exact: true })).toBeVisible();
      await expect(page.getByRole('article')).toHaveCount(0);
      await page.getByRole('tab', { name: '知识卡片', exact: true }).click();
      await expect(page.getByRole('article')).toContainText('本人草稿');
      release();
      await expect(page.getByRole('tab', { name: '知识卡片', exact: true })).toHaveAttribute('aria-selected', 'true');
      await expect(page.getByRole('article')).toContainText('知识卡片');
      await expect(page).toHaveURL(/type=knowledge/);
    } finally { release(); }
  });

  test('an empty result set keeps its committed search and selected type', async ({ page }) => {
    await page.route('**/api/search?*', route => route.fulfill({ json: { items: [], total: 0, page: 1, per_page: 20, totalPages: 0 } }));
    await page.goto('/search?q=no-match&type=radar');
    await expect(page.getByRole('heading', { name: '没有匹配的内容' })).toBeVisible();
    await expect(page.getByRole('searchbox', { name: '搜索关键词' })).toHaveValue('no-match');
    await expect(page.getByRole('tab', { name: '雷达', exact: true })).toHaveAttribute('aria-selected', 'true');
    await expect(page.getByRole('navigation', { name: '分页', exact: true })).toHaveCount(0);
  });

  for (const theme of ['light', 'dark'] as const) {
    test(`${theme}: shared typography, responsive tabs and unexempted accessibility`, async ({ page }, testInfo) => {
      const errors: string[] = [];
      page.on('pageerror', error => errors.push(error.message));
      page.on('console', message => {
        if (message.type() === 'error' && /hydration|did not match/i.test(message.text())) errors.push(message.text());
      });
      await page.addInitScript(mode => localStorage.setItem('dr-theme', mode), theme);
      for (const width of [1440, 1024, 768, 390, 320]) {
        await page.setViewportSize({ width, height: 900 });
        await page.goto('/search?q=Responsive&type=knowledge');
        const title = page.getByRole('article').getByRole('heading');
        await expect(title).toBeVisible();
        await expect(page.locator('html')).toHaveClass(new RegExp(theme));
        expect(await title.evaluate(element => getComputedStyle(element).fontSize)).toBe('16px');
        expect(await page.getByRole('article').locator('p').evaluate(element => getComputedStyle(element).fontSize)).toBe('14px');
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
        await page.getByRole('tab', { name: '知识卡片', exact: true }).press('Home');
        await expect(page.getByRole('tab', { name: '全部', exact: true })).toHaveAttribute('aria-selected', 'true');
        await expect(page.getByRole('article').getByText('雷达', { exact: true })).toBeVisible();
        const submit = page.getByRole('button', { name: '搜索', exact: true });
        await expect(submit).toBeEnabled();
        // Scan the settled result, not an intermediate disabled-to-enabled color.
        await submit.evaluate(async element => {
          await Promise.all(element.getAnimations().map(animation => animation.finished.catch(() => undefined)));
        });
        expect((await new AxeBuilder({ page }).include('main').analyze()).violations).toEqual([]);
        if (width === 390) await page.screenshot({ path: testInfo.outputPath(`search-${theme}-390.png`) });
      }
      expect(errors).toEqual([]);
    });
  }
});
