// 公共流程 E2E：登录跳转 + 未登录访问受保护页
//
// 注意：Playwright + 真实 NextAuth 流程比较慢；本测试只验证：
//   - /signin 页面存在
//   - 未登录访问 /admin → 跳 /signin
//   - 未登录访问 /summaries/[id] 等公开页 → 200

import { test, expect } from '@playwright/test';

test.describe('Public flows', () => {
  test('signin page is reachable', async ({ page }) => {
    const response = await page.goto('/signin');
    expect(response?.status()).toBe(200);
    await expect(page.locator('body')).toContainText(/登录|signin|Google/i);
  });

  test('unauthenticated /admin redirects to /signin', async ({ page }) => {
    const response = await page.goto('/admin');
    // Server-side redirect: 200 with /signin in URL, or 307 redirect chain
    await expect(page).toHaveURL(/\/signin/);
    expect(response?.status() ?? 200).toBeLessThan(500);
  });

  test('public /summaries page is reachable', async ({ page }) => {
    const response = await page.goto('/summaries');
    expect(response?.status()).toBe(200);
  });

  test('home / page is reachable', async ({ page }) => {
    const response = await page.goto('/');
    expect(response?.status()).toBe(200);
  });
});

test.describe('Admin gate (server-side)', () => {
  test('unauthenticated accessing /admin redirects to signin (server-side)', async ({ page }) => {
    await page.goto('/admin');
    await expect(page).toHaveURL(/\/signin/);
  });

  test('unauthenticated accessing /api/admin/dashboard returns 401/403', async ({ request }) => {
    const res = await request.get('/api/admin/dashboard');
    expect([401, 403, 307]).toContain(res.status());
  });
});