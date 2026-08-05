// 调研库流程 E2E（Week 9+ 起步骨架）
//
// 覆盖：
//   - 调研库列表页加载
//   - 调研库新建页加载（需登录）
//   - 调研库详情对不存在 id 的处理

import { test, expect } from '@playwright/test';
import { loginWithCredentials } from './fixtures';

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

  test('owner can permanently delete a draft after confirmation', async ({ page }) => {
    await loginWithCredentials(page.context().request, {
      email: 'member@shopee.com',
      role: 'member',
    });

    const title = `E2E 删除草稿 ${Date.now()}`;
    const created = await page.request.post('/api/researches', {
      data: {
        type: 'research',
        title,
        body: '这是一份用于验证删除流程的临时草稿。',
        tags: ['e2e-delete'],
      },
    });
    expect(created.status()).toBe(201);
    const draft = await created.json() as { id: string };

    try {
      await page.goto('/researches?tab=draft');
      await expect(page.getByRole('button', { name: `删除草稿：${title}` })).toBeVisible();

      await page.goto(`/researches/${draft.id}`);
      await page.getByRole('button', { name: `删除草稿：${title}` }).click();
      await expect(page.getByRole('dialog')).toContainText('此操作无法撤销');
      await page.getByRole('button', { name: '永久删除' }).click();

      await expect(page).toHaveURL(/\/researches\?tab=draft/u);
      const deleted = await page.request.get(`/api/researches/${draft.id}`);
      expect(deleted.status()).toBe(404);
    } finally {
      await page.request.delete(`/api/researches/${draft.id}`).catch(() => undefined);
    }
  });
});
