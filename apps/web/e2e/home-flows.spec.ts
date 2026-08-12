// 首页 E2E：首页直接进入技术雷达，主导航和搜索入口可用。

import { test, expect, type Page } from '@playwright/test';
import { loginWithCredentials } from './fixtures';

async function gotoHome(page: Page) {
  const response = await page.goto('/');
  expect(response?.status() ?? 200).toBeLessThan(500);
  await page.waitForLoadState('domcontentloaded');
}

test.describe('Homepage (anonymous)', () => {
  test('redirects the root page to the technical radar', async ({ page }) => {
    await gotoHome(page);
    await expect(page).toHaveURL(/\/radar$/);
    await expect(page.locator('h1', { hasText: '技术雷达' })).toBeVisible();
    await expect(page.getByRole('navigation', { name: '主导航' })).toBeVisible();
  });

  test('top navigation exposes radar, topics, research and AI research', async ({ page }) => {
    await gotoHome(page);
    for (const label of ['技术雷达', '热点主题', '调研库', 'AI 调研']) {
      await expect(page.getByRole('link', { name: label, exact: true })).toBeVisible();
    }
    await expect(page.getByRole('button', { name: /打开全局搜索/ })).toBeVisible();
  });
});

test.describe('Homepage (member)', () => {
  test('logged-in homepage remains the radar surface', async ({ page }) => {
    await loginWithCredentials(page.context().request, {
      email: 'member@shopee.com',
      role: 'member',
    });

    await gotoHome(page);
    await expect(page).toHaveURL(/\/radar$/);
    await expect(page.locator('h1', { hasText: '技术雷达' })).toBeVisible();
  });
});
