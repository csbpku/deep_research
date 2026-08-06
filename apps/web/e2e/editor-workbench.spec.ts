import type { Page } from '@playwright/test';
import { test, expect } from './fixtures';

async function createDraft(page: Page) {
  const response = await page.request.post('/api/researches', {
    data: {
      type: 'research',
      title: `E2E 三栏工作台 ${Date.now()}`,
      body: '# 研究问题\n\n## 证据\n\n### 限制\n\n正文内容',
      conclusion: '待核验结论',
      risks: '待补充风险',
      tags: ['e2e-workbench'],
    },
  });
  expect(response.status()).toBe(201);
  return (await response.json() as { id: string }).id;
}

test.describe('Research editor workbench', () => {
  test.setTimeout(60_000);

  test('desktop exposes outline, editor, and auxiliary tabs', async ({ page }) => {
    const id = await createDraft(page);
    try {
      await page.goto(`/researches/${id}/edit`);
      await expect(page.getByLabel('正文 Markdown')).toBeVisible({ timeout: 15_000 });
      await expect(page.getByText('文章结构', { exact: true })).toBeVisible({ timeout: 15_000 });
      await expect(page.getByRole('tab', { name: '来源', exact: true })).toBeVisible();
      await expect(page.getByRole('tab', { name: 'AI 助手' })).toBeVisible();
      await expect(page.getByRole('tab', { name: '版本历史' })).toBeVisible();
      await expect(page.getByRole('tab', { name: '文章信息' })).toBeVisible();
      await expect(page.getByRole('tab', { name: '讨论' })).toHaveCount(0);
      await expect(page.getByText('草稿', { exact: true })).toBeVisible();
      await expect(page.getByRole('button', { name: '收起总览导航' })).toBeVisible();
      await page.getByRole('button', { name: '收起总览导航' }).click();
      await expect(page.getByRole('button', { name: '展开总览导航' })).toBeVisible();

      // All three desktop rails expose both pointer and keyboard resizing.
      await page.getByRole('button', { name: '展开总览导航' }).click();
      const shellResize = page.getByRole('separator', { name: '调整总览导航宽度' });
      const outlineResize = page.getByRole('separator', { name: '调整文章结构栏宽度' });
      const toolsResize = page.getByRole('separator', { name: '调整研究工具栏宽度' });
      await expect(shellResize).toBeVisible();
      await expect(outlineResize).toBeVisible();
      await expect(toolsResize).toBeVisible();
      await outlineResize.press('Home');
      await expect(outlineResize).toHaveAttribute('aria-valuenow', '150');
      await toolsResize.press('End');
      await expect(toolsResize).toHaveAttribute('aria-valuenow', '460');

      const body = page.getByLabel('正文 Markdown');
      await body.fill('/tab');
      await body.press('Enter');
      await expect(body).toHaveValue(/\| 维度 \| 结论 \| 证据 \|/u);
    } finally {
      await page.request.delete(`/api/researches/${id}`).catch(() => undefined);
    }
  });

  test('mobile moves outline and research support into panels', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    const id = await createDraft(page);
    try {
      await page.goto(`/researches/${id}/edit`);
      await expect(page.getByRole('button', { name: /文章大纲/ })).toBeVisible();
      await expect(page.getByRole('button', { name: '研究工具' })).toBeVisible();
      await page.getByRole('button', { name: '研究工具' }).click();
      await expect(page.getByRole('button', { name: '关闭研究工具', exact: true })).toBeVisible();
      await expect(page.getByRole('tab', { name: '来源', exact: true })).toBeVisible();
      await expect(page.getByRole('tab', { name: '讨论' })).toHaveCount(0);
    } finally {
      await page.request.delete(`/api/researches/${id}`).catch(() => undefined);
    }
  });
});
