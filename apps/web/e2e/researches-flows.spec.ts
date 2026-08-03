// 调研库流程 E2E（Week 9+ 起步骨架）
//
// 覆盖：
//   - 调研库列表页加载
//   - 调研库新建页加载（需登录）
//   - 调研库详情对不存在 id 的处理

import { test, expect } from '@playwright/test';

test.describe('Research flows', () => {
  test('researches list page renders', async ({ page }) => {
    const res = await page.goto('/researches');
    expect(res?.status()).toBe(200);
    await expect(page.locator('body')).toContainText(/调研库|researches/i);
  });

  test('draft deep link selects 我的草稿 tab', async ({ page }) => {
    const res = await page.goto('/researches?tab=draft');
    expect(res?.status()).toBe(200);
    await expect(page.getByRole('tab', { name: '我的草稿' })).toHaveAttribute('data-state', 'active');
  });

  test('research detail page handles missing id gracefully', async ({ page }) => {
    const fakeId = '00000000-0000-4000-8000-000000000000';
    const res = await page.goto(`/researches/${fakeId}`);
    expect([200, 404]).toContain(res?.status() ?? 0);
  });
});
