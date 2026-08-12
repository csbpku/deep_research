// AI 调研流程 E2E
//
// 覆盖：
//   - AI 调研对话页加载
//   - 对话输入和发送按钮
//   - 详情页：刷新按钮、重试入口、statusLabel 本地化
//   - 父页：EmptyState 错误 / 空态、产物确认卡片

import { test, expect } from '@playwright/test';
import { loginWithCredentials } from './fixtures';

test.describe('AI Research flows', () => {
  test('ai-research form page renders', async ({ page }) => {
    const res = await page.goto('/ai-research');
    expect(res?.status()).toBe(200);
    await expect(page.locator('body')).toContainText(/AI 调研|ai.research/i);
  });

  test('conversation input and send button exist', async ({ page }) => {
    await page.goto('/ai-research');
    await expect(page.getByRole('textbox', { name: 'AI 调研对话输入' })).toBeVisible();
    await expect(page.getByRole('button', { name: '发送消息' })).toBeVisible();
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
      if (firstCall) firstCall = false;
      return route.fulfill({ status: 500, body: 'fail' });
    });
    await page.goto('/ai-research/48844f9d-01aa-4ca9-a923-2ecb636656a9');
    await page.waitForLoadState('networkidle').catch(() => {});
    // 错误 EmptyState 应有「重试」按钮
    const retry = page.getByRole('button', { name: '重试' }).first();
    await expect(retry).toBeVisible();
  });
});

test.describe('AI Research parent (UI polish)', () => {
  test('starting a research stays in the conversation workspace', async ({ page }) => {
    await page.route('**/api/ai-research', (route) => {
      if (route.request().method() === 'POST') {
        return route.fulfill({
          status: 202,
          contentType: 'application/json',
          body: JSON.stringify({ jobId: '11111111-1111-4111-8111-111111111111' }),
        });
      }
      return route.continue();
    });
    await page.route('**/api/ai-research/11111111-1111-4111-8111-111111111111', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          jobId: '11111111-1111-4111-8111-111111111111',
          topic: '研究 GraphRAG',
          status: 'running',
          finalStatus: null,
          currentStep: 'search',
          sourcesCount: 2,
          partialSourcesCount: 0,
          failedSourcesCount: 0,
          draftResearchId: null,
          reportType: 'research_report',
          outputText: null,
          errorCode: null,
          errorMessage: null,
          artifact: null,
        }),
      }),
    );
    await page.goto('/ai-research');
    const input = page.getByRole('textbox', { name: 'AI 调研对话输入' });
    await input.fill('研究 GraphRAG');
    await page.getByRole('button', { name: '发送消息' }).click();
    await input.fill('无');
    await page.getByRole('button', { name: '发送消息' }).click();
    await page.getByRole('button', { name: '开始调研' }).click();
    await expect(page).toHaveURL(/\/ai-research$/);
    await expect(page.getByText('调研正在当前页面运行')).toBeVisible();
  });

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
    const input = page.getByRole('textbox', { name: 'AI 调研对话输入' });
    await input.fill('测试失败用例');
    await page.getByRole('button', { name: '发送消息' }).click();
    await input.fill('无');
    await page.getByRole('button', { name: '发送消息' }).click();
    await page.getByRole('button', { name: '开始调研' }).click();
    // 错误 alert 应有「重试」按钮
    const alert = page.getByRole('alert').filter({ hasText: /请求失败|提交失败|AI 调研服务/ }).first();
    await expect(alert).toBeVisible();
    await expect(alert.getByRole('button', { name: '重试' })).toBeVisible();
  });

  test('conversation confirms source policy and output type', async ({ page }) => {
    await page.goto('/ai-research');
    await page.waitForLoadState('networkidle').catch(() => {});
    const input = page.getByRole('textbox', { name: 'AI 调研对话输入' });
    await input.fill('研究 GraphRAG');
    await page.getByRole('button', { name: '发送消息' }).click();
    await input.fill('无');
    await page.getByRole('button', { name: '发送消息' }).click();
    await expect(page.getByText('研究稿')).toBeVisible();
    await expect(page.getByText('优先指定资料')).toBeVisible();
  });

  test('research artifact card defaults to markdown research draft', async ({ page }) => {
    await page.goto('/ai-research');
    const input = page.getByRole('textbox', { name: 'AI 调研对话输入' });
    await input.fill('研究 GraphRAG');
    await page.getByRole('button', { name: '发送消息' }).click();
    await input.fill('无');
    await page.getByRole('button', { name: '发送消息' }).click();
    await expect(page.getByText('完整调研、引用和可编辑草稿')).toBeVisible();
  });
});
