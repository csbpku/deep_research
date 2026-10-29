import { test, expect, type Page } from '@playwright/test';
import { isolatedMuiOrigin, loginMuiFixture } from './mui-local-fixtures';

const id = '10000000-0000-4000-8000-000000000071';
const source = 'https://example.com/preview-scroll-fixture';
const interpretation = Array.from({ length: 24 }, (_, i) => `第 ${i + 1} 段：验证较长的技术摘要只在概览正文内滚动，底部原文入口保持可用。`).join('\n\n');
const candidate = {
  id, title: '概览视口回归：长摘要与固定操作区', url: source,
  excerpt: '用于滚动布局验收的合成内容。', interpretation, scoreReason: null,
  distilledScore: null, tier: 'deep_read', selectionReason: null, sourceType: 'rss',
  sourceName: '隔离验收来源', originalKind: 'article', tags: [], status: 'published',
  publishedAt: null, crawledAt: '2026-10-20T00:00:00Z',
  relevanceScore: null, timelinessScore: null, sourceQualityScore: null, sortOrder: null,
  commentCount: 0, topics: [], issues: [], isAuthenticated: true,
  feedbackCounts: { favorite: 0, useful: 0, inaccurate: 0, used: 0, suggest_research: 0 },
  myFeedbacks: [],
};

async function setup(page: Page) {
  await page.route('**/api/radar?*', route => route.fulfill({ json: {
    items: Array.from({ length: 20 }, (_, i) => ({ ...candidate, id: i === 0 ? id : `10000000-0000-4000-8000-${String(i).padStart(12, '0')}`, title: i === 0 ? candidate.title : `后续雷达 ${i}` })),
    page: 1, perPage: 20, total: 40, totalPages: 2,
  } }));
  await page.route(`**/api/radar/${id}?*`, route => route.fulfill({ json: candidate }));
  await page.route('**/api/knowledge/related?*', route => route.fulfill({ json: { items: [] } }));
  await page.route('**/api/ai-research/jobs?*', route => route.fulfill({ json: { items: [], total: 0 } }));
  await page.context().route(`${source}**`, route => route.fulfill({ contentType: 'text/html', body: '<main><h1>Original article</h1></main>' }));
}

async function confirmSource(page: Page) {
  // "打开原文"是直链：Reader 不再是阅读的前置条件。
  const sourcePromise = page.waitForEvent('popup');
  await page.getByRole('link', { name: '打开原文', exact: true }).click();
  const sourcePage = await sourcePromise;
  await expect(sourcePage.getByRole('heading', { name: 'Original article' })).toBeVisible();
  await sourcePage.close();
}

async function controlsFit(page: Page) {
  return page.getByRole('complementary', { name: '文章概览', exact: true }).filter({ visible: true }).evaluate(panel => {
    const main = document.getElementById('main-content')!;
    const port = main.getBoundingClientRect();
    const bounds = panel.getBoundingClientRect();
    const button = Array.from(panel.querySelectorAll('a')).find(item => item.textContent?.includes('打开原文'))!;
    const target = button.getBoundingClientRect();
    const close = panel.querySelector('button[aria-label="关闭预览"]')!.getBoundingClientRect();
    const hit = document.elementFromPoint(target.left + target.width / 2, target.top + target.height / 2);
    return {
      fits: bounds.top >= port.top - 1 && bounds.bottom <= Math.min(port.bottom, innerHeight) + 1
        && target.bottom <= Math.min(port.bottom, innerHeight, bounds.bottom) + 1
        && close.top >= port.top - 1 && close.bottom <= innerHeight,
      clickable: hit === button || Boolean(hit && button.contains(hit)),
    };
  });
}

test.describe('Radar preview stays inside the scroll viewport', () => {
  test.skip(process.env.MUI_ISOLATED_BROWSER !== '1', 'Requires the local isolated fixture service');
  test.beforeEach(async ({ page }) => {
    isolatedMuiOrigin();
    await loginMuiFixture(page.request, 'member');
    await setup(page);
  });

  test('desktop cold ?open entry has no modal intercepting source or list controls', async ({ page }, testInfo) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(`/radar?open=${id}`);
    await expect(page.locator(`[data-radar-knowledge-id="${id}"]`).filter({ visible: true })).toBeVisible();
    await expect(page.locator('.MuiDrawer-root.MuiModal-root')).toHaveCount(0);
    await expect(page.locator('main')).not.toHaveAttribute('aria-hidden', 'true');
    await expect.poll(() => controlsFit(page)).toEqual({ fits: true, clickable: true });
    await page.screenshot({ path: testInfo.outputPath('cold-open-desktop.png') });
    const button = page.getByRole('link', { name: '打开原文', exact: true });
    const bounds = (await button.boundingBox())!;
    await page.mouse.click(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2);
    await confirmSource(page);
    await expect(page.getByRole('button', { name: '关闭预览', exact: true })).toBeVisible();
    await expect(page.locator('.MuiDrawer-root.MuiModal-root')).toHaveCount(0);
    await page.getByRole('button', { name: '关闭预览', exact: true }).click();
    await expect(page.locator('[data-radar-knowledge-id]')).toHaveCount(0);
    await page.getByRole('button', { name: '按来源浏览', exact: true }).click();
    await expect(page.getByRole('button', { name: '按来源浏览', exact: true })).toHaveAttribute('aria-pressed', 'true');
  });

  test('cold mobile preview releases modal, scroll lock and focus trap when resized to desktop', async ({ page }, testInfo) => {
    await page.setViewportSize({ width: 390, height: 640 });
    await page.goto(`/radar?open=${id}`);
    await expect(page.getByRole('dialog', { name: '文章概览', exact: true })).toBeVisible();
    await page.setViewportSize({ width: 1440, height: 900 });
    await expect(page.locator('.MuiDrawer-root.MuiModal-root')).toHaveCount(0);
    await expect(page.locator('main')).not.toHaveAttribute('aria-hidden', 'true');
    await expect.poll(() => controlsFit(page)).toEqual({ fits: true, clickable: true });
    expect(await page.locator('body').evaluate(element => getComputedStyle(element).overflow)).not.toBe('hidden');
    await page.setViewportSize({ width: 390, height: 640 });
    await expect(page.getByRole('dialog', { name: '文章概览', exact: true })).toBeVisible();
    await page.screenshot({ path: testInfo.outputPath('cold-open-mobile.png') });
    await page.getByRole('button', { name: '关闭预览', exact: true }).click();
    await expect(page.getByRole('dialog', { name: '文章概览', exact: true })).toHaveCount(0);
    await expect(page.getByRole('button', { name: '筛选', exact: true })).toBeVisible();
  });

  for (const viewport of [
    { width: 1440, height: 900 }, { width: 1280, height: 600 }, { width: 1024, height: 480 },
  ]) {
    test(`${viewport.width}x${viewport.height}: top, middle, bottom and window resize keep the source button clickable`, async ({ page }, testInfo) => {
      await page.setViewportSize(viewport);
      await page.goto('/radar?date=all');
      await page.getByRole('link', { name: candidate.title, exact: true }).click();
      const panel = page.getByRole('complementary', { name: '文章概览', exact: true }).filter({ visible: true });
      const main = page.getByRole('main');
      await expect.poll(() => controlsFit(page)).toEqual({ fits: true, clickable: true });
      const initialScroll = await main.evaluate(element => element.scrollTop);
      if (viewport.height >= 600) expect(initialScroll).toBe(0);
      else expect(initialScroll).toBeLessThan(await main.evaluate(element => element.clientHeight));
      await page.screenshot({ path: testInfo.outputPath(`preview-top-${viewport.width}.png`) });

      const body = panel.locator('[data-radar-preview-body]');
      expect(await body.evaluate(element => element.scrollHeight > element.clientHeight)).toBe(true);
      await body.evaluate(element => { element.scrollTop = element.scrollHeight; });
      await expect.poll(() => controlsFit(page)).toEqual({ fits: true, clickable: true });
      expect(await main.evaluate(element => element.scrollTop)).toBe(initialScroll);

      for (const position of ['middle', 'bottom', 'top']) {
        await main.evaluate((element, where) => {
          element.scrollTop = where === 'top' ? 0 : where === 'bottom' ? element.scrollHeight : (element.scrollHeight - element.clientHeight) / 2;
        }, position);
        await page.evaluate(async () => {
          for (let i = 0; i < 8; i++) await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
        });
        await expect.poll(() => controlsFit(page)).toEqual({ fits: true, clickable: true });
      }
      await page.setViewportSize({ width: viewport.width, height: viewport.height - 80 });
      await expect.poll(() => controlsFit(page)).toEqual({ fits: true, clickable: true });
      const button = panel.getByRole('link', { name: '打开原文', exact: true });
      const bounds = (await button.boundingBox())!;
      // A coordinate click cannot auto-scroll the document to conceal clipping.
      await page.mouse.click(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2);
      await confirmSource(page);
    });
  }

  test('mobile bottom drawer keeps its header and actions visible while its body scrolls', async ({ page }, testInfo) => {
    await page.setViewportSize({ width: 390, height: 640 });
    await page.goto('/radar?date=all');
    await page.getByRole('link', { name: candidate.title, exact: true }).click();
    const dialog = page.getByRole('dialog', { name: '文章概览', exact: true });
    const button = dialog.getByRole('link', { name: '打开原文', exact: true });
    await expect(button).toBeInViewport({ ratio: 1 });
    const body = dialog.locator('[data-radar-preview-body]');
    await body.evaluate(element => { element.scrollTop = element.scrollHeight; });
    await expect(button).toBeInViewport({ ratio: 1 });
    await expect(dialog.getByRole('button', { name: '关闭预览' })).toBeInViewport({ ratio: 1 });
    await page.screenshot({ path: testInfo.outputPath('preview-mobile.png') });
    const bounds = (await button.boundingBox())!;
    await page.mouse.click(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2);
    await confirmSource(page);
  });
});
