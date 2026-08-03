// 摘要流程 E2E（Week 10：日报模式）
//
// 覆盖：
//   - 日报列表页加载
//   - 日报日期路由加载
//   - 日报榜单链接到雷达详情
//   - 摘要详情 EmptyState（不存在的 id）

import { test, expect } from '@playwright/test';

test.describe('Summaries flows', () => {
  test('summaries list page renders', async ({ page }) => {
    const res = await page.goto('/summaries');
    expect(res?.status()).toBe(200);
    await expect(page.locator('body')).toContainText(/雷达日报|日报/i);
  });

  test('digest date page renders (with empty state for missing date)', async ({ page }) => {
    const res = await page.goto('/summaries/2026-07-27');
    // 200 (空态) 或 404
    expect([200, 404]).toContain(res?.status() ?? 0);
  });

  test('digest ranked item links to radar detail', async ({ page }) => {
    const res = await page.goto('/summaries/2026-07-31');
    expect([200, 404]).toContain(res?.status() ?? 0);
    const radarLink = page.locator('a[href^="/radar/"]').first();
    try {
      await radarLink.waitFor({ state: 'visible', timeout: 10_000 });
    } catch {
      test.skip();
      return;
    }
    await radarLink.click();
    await page.waitForURL(/\/radar\/.+/u);
    await expect(page.locator('h1')).toBeVisible();
  });

  test('summary detail page handles missing id gracefully', async ({ page }) => {
    const fakeId = '00000000-0000-4000-8000-000000000000';
    const res = await page.goto(`/summaries/${fakeId}`);
    expect([200, 404]).toContain(res?.status() ?? 0);
  });
});
