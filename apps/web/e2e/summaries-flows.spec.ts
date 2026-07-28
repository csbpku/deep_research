// 摘要流程 E2E（Week 9+ 起步骨架）
//
// 覆盖：
//   - 摘要列表页加载
//   - 摘要 by-date 路由加载
//   - 摘要详情 EmptyState（不存在的 id）

import { test, expect } from '@playwright/test';

test.describe('Summaries flows', () => {
  test('summaries list page renders', async ({ page }) => {
    const res = await page.goto('/summaries');
    expect(res?.status()).toBe(200);
    await expect(page.locator('body')).toContainText(/摘要|summaries/i);
  });

  test('summaries by-date page renders (with empty state for missing date)', async ({ page }) => {
    const res = await page.goto('/summaries/by-date/2026-07-27');
    // 200 (空态) 或 404
    expect([200, 404]).toContain(res?.status() ?? 0);
  });

  test('summary detail page handles missing id gracefully', async ({ page }) => {
    const fakeId = '00000000-0000-4000-8000-000000000000';
    const res = await page.goto(`/summaries/${fakeId}`);
    expect([200, 404]).toContain(res?.status() ?? 0);
  });
});