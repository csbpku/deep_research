// 公共流程 E2E：登录跳转 + 未登录访问受保护页
//
// 注意：Playwright + 真实 NextAuth 流程比较慢；本测试只验证：
//   - /signin 页面存在
//   - 未登录访问 /admin → 跳 /signin
//   - 未登录访问 /summaries/[id] 等公开页 → 200

import { test, expect } from '@playwright/test';
import { loginWithCredentials } from './fixtures';

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

  test('anonymous radar list hides deep research actions', async ({ page }) => {
    await page.goto('/radar');
    await expect(page.getByRole('link', { name: '深入调研' })).toHaveCount(0);
  });
});

test.describe('Member radar to research flow', () => {
  test('member can open a radar candidate as a prefilled AI research', async ({ page }) => {
    await loginWithCredentials(page.context().request, {
      email: 'member@shopee.com',
      role: 'member',
    });

    const radarResponse = await page.request.get('/api/radar?quality=relevant&page=1&per_page=1');
    expect(radarResponse.ok()).toBe(true);
    const radar = await radarResponse.json() as {
      items: Array<{ id: string; title: string; interpretation: string | null; url: string }>;
    };
    test.skip(radar.items.length === 0, '需要至少一条雷达候选验证预填流程');
    const candidate = radar.items[0];

    await page.goto('/radar');
    await expect(page.getByRole('link', { name: '深入调研' }).first()).toBeVisible();

    await page.goto(`/radar/${candidate.id}`);
    const detailAction = page.getByRole('link', { name: '深入调研' });
    await expect(detailAction).toBeVisible();
    await detailAction.click();

    await expect(page).toHaveURL(`/ai-research?seed=${candidate.id}`);
    await expect(page.getByLabel(/^主题/)).toHaveValue(candidate.title.slice(0, 200));
    await expect(page.getByLabel(/团队背景/)).toHaveValue(new RegExp(candidate.url.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&'), 'u'));
    await expect(page.getByText(candidate.title, { exact: true })).toBeVisible();
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
