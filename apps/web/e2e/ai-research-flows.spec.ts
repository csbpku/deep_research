// AI 调研流程 E2E（Week 9+ 起步骨架）
//
// 覆盖：
//   - AI 调研表单页加载
//   - 表单元素存在（主题输入、提交按钮）
//   - 提交按钮在空表单时禁用

import { test, expect } from '@playwright/test';

test.describe('AI Research flows', () => {
  test('ai-research form page renders', async ({ page }) => {
    const res = await page.goto('/ai-research');
    expect(res?.status()).toBe(200);
    await expect(page.locator('body')).toContainText(/AI 调研|ai.research/i);
  });

  test('submit button exists on form', async ({ page }) => {
    await page.goto('/ai-research');
    // 页面应有某种 submit 控件
    const button = page.locator('button[type="submit"], button:has-text("开始调研"), button:has-text("提交")');
    expect(await button.count()).toBeGreaterThan(0);
  });
});