// AI 调研流程 E2E（Week 9+ 起步骨架）
//
// 覆盖：
//   - AI 调研表单页加载
//   - 表单元素存在（主题输入、提交按钮）
//   - 提交按钮在空表单时禁用
//   - 详情页：刷新按钮、重试入口、statusLabel 本地化
//   - 父页：EmptyState 错误 / 空态、StatusRow 卡片化、报告类型卡片选中态

import { test, expect } from '@playwright/test';
import { loginWithCredentials } from './fixtures';

test.describe('AI Research flows', () => {
  test('ai-research form page renders', async ({ page }) => {
    const res = await page.goto('/ai-research');
    expect(res?.status()).toBe(200);
    await expect(page.locator('body')).toContainText(/AI 调研|ai.research/i);
  });

  test('submit button exists on form', async ({ page }) => {
    await page.goto('/ai-research');
    const button = page.locator('button[type="submit"], button:has-text("开始调研"), button:has-text("提交")');
    expect(await button.count()).toBeGreaterThan(0);
  });
});

test.describe('AI Research detail (UI polish)', () => {
  test('header refresh button exists', async ({ page }) => {
    await page.goto('/ai-research/48844f9d-01aa-4ca9-a923-2ecb636656a9');
    // 加载完后 header 应有「刷新」按钮
    await page.waitForLoadState('networkidle').catch(() => {});
    const refresh = page.getByRole('button', { name: /刷新调研状态/ });
    await expect(refresh).toBeVisible();
  });

  test('error empty state has retry button', async ({ page }) => {
    // 模拟网络错误:route /api/ai-research/<id> 第一次返回 500
    let firstCall = true;
    await page.route('**/api/ai-research/48844f9d-01aa-4ca9-a923-2ecb636656a9', (route) => {
      if (firstCall) {
        firstCall = false;
        return route.fulfill({ status: 500, body: 'fail' });
      }
      return route.continue();
    });
    await page.goto('/ai-research/48844f9d-01aa-4ca9-a923-2ecb636656a9');
    await page.waitForLoadState('networkidle').catch(() => {});
    // 错误 EmptyState 应有「重试」按钮
    const retry = page.getByRole('button', { name: '重试' }).first();
    await expect(retry).toBeVisible();
  });
});

test.describe('AI Research parent (UI polish)', () => {
  test('history empty state uses EmptyState (not raw text)', async ({ page }) => {
    // 拦截 /api/ai-research/jobs 返回空数组
    await page.route('**/api/ai-research/jobs*', (route) =>
      route.fulfill({ status: 200, contentType: 'application/json', body: '{"items":[],"total":0,"limit":50,"offset":0}' }),
    );
    await page.goto('/ai-research');
    await page.waitForLoadState('networkidle').catch(() => {});
    await expect(page.getByText('还没有调研任务')).toBeVisible();
  });

  test('history error state has retry button', async ({ page }) => {
    await page.route('**/api/ai-research/jobs*', (route) =>
      route.fulfill({ status: 500, body: 'fail' }),
    );
    await page.goto('/ai-research');
    await page.waitForLoadState('networkidle').catch(() => {});
    const retry = page.getByRole('button', { name: '重试' }).first();
    await expect(retry).toBeVisible();
  });

  test('form error alert has retry button', async ({ page }) => {
    // 拦截 POST 返回 500
    await page.route('**/api/ai-research', (route) => {
      if (route.request().method() === 'POST') {
        return route.fulfill({ status: 500, body: 'fail' });
      }
      return route.continue();
    });
    await loginWithCredentials(page.context().request, {
      email: 'member@shopee.com',
      role: 'member',
    });
    await page.goto('/ai-research');
    // 填主题
    await page.locator('#ai-topic').fill('测试失败用例');
    await page.locator('button[type="submit"]').first().click();
    // 错误 alert 应有「重试」按钮
    const alert = page.getByRole('alert');
    await expect(alert).toBeVisible();
    await expect(alert.getByRole('button', { name: '重试' })).toBeVisible();
  });

  test('StatusRow uses SectionCard with current mode label', async ({ page }) => {
    await page.goto('/ai-research');
    await page.waitForLoadState('networkidle').catch(() => {});
    // "当前模式" 是 SectionCard 的 title
    await expect(page.getByText('当前模式', { exact: true })).toBeVisible();
    // 模式描述也在
    await expect(page.getByText(/优先参考所选资料/)).toBeVisible();
  });

  test('report type radio uses card style with selected token', async ({ page }) => {
    await page.goto('/ai-research');
    // 报告类型默认是 research_report,选中态应有 border-primary class
    const reportLabels = page.locator('label:has(input[name="reportType"])');
    const selected = reportLabels.filter({ has: page.locator('input:checked') });
    await expect(selected.first()).toHaveClass(/border-primary/);
  });
});
