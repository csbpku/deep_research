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
    await expect(page.getByRole('region', { name: '本次研究收据' })).toContainText('本次研究已提交');
  });

  test('history empty state uses EmptyState (not raw text)', async ({ page }) => {
    // 拦截 /api/ai-research/jobs 返回空数组
    await page.route('**/api/ai-research/jobs*', (route) =>
      route.fulfill({ status: 200, contentType: 'application/json', body: '{"items":[],"total":0,"limit":50,"offset":0}' }),
    );
    await page.goto('/ai-research');
    await page.waitForLoadState('networkidle').catch(() => {});
    await page.getByRole('button', { name: '查看全部任务' }).click();
    await expect(page.getByText('还没有调研任务')).toBeVisible();
  });

  test('history error state has retry button', async ({ page }) => {
    await page.route('**/api/ai-research/jobs*', (route) =>
      route.fulfill({ status: 500, body: 'fail' }),
    );
    await page.goto('/ai-research');
    await page.waitForLoadState('networkidle').catch(() => {});
    await page.getByRole('button', { name: '查看全部任务' }).click();
    const retry = page.getByRole('button', { name: '重试' }).first();
    await expect(retry).toBeVisible();
  });

  test('recent research stays compact and full history opens in a drawer', async ({ page }) => {
    await page.goto('/ai-research');
    const history = page.getByRole('button', { name: '查看全部任务' });
    await expect(history).toBeVisible();
    await history.click();
    const drawer = page.getByRole('dialog', { name: '调研历史' });
    await expect(drawer).toBeVisible();
    await expect(drawer.getByRole('button', { name: '失败' })).toBeVisible();
    await drawer.getByRole('button', { name: '关闭' }).click();
    await expect(drawer).toBeHidden();
  });

  test('history keeps task actions reachable on a narrow mobile viewport', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.route('**/api/ai-research/jobs*', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          items: [{
            jobId: '55555555-5555-4555-8555-555555555555',
            topic: '移动端历史任务操作可达性',
            status: 'succeeded',
            currentStep: null,
            reportType: 'slides',
            reportLength: 'standard',
            hasReport: true,
            capturedSourcesCount: 3,
            deliverableStatus: 'report',
            sourcePolicy: 'prefer_user_sources',
            sourceRefs: [],
            draftResearchId: null,
            publishedResearchId: null,
            createdAt: '2026-09-04T04:00:00.000Z',
          }],
          total: 1,
          limit: 50,
          offset: 0,
        }),
      }),
    );
    await page.goto('/ai-research');
    await page.getByRole('button', { name: '查看全部任务' }).click();
    const drawer = page.getByRole('dialog', { name: '调研历史' });
    await expect(drawer.getByRole('link', { name: '打开' })).toBeVisible();
    await expect(drawer.getByRole('button', { name: '重新运行' })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
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
    await input.fill('评估 AI 调研请求失败时的重试体验');
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
    await expect(page.getByRole('button', { name: /研究稿.*完整调研、引用和可编辑草稿/u })).toBeVisible();
    await expect(page.getByRole('button', { name: /网页搜索 \+ 已选资料/u })).toBeVisible();
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

  test('slides artifact is rendered once as a bounded outline', async ({ page }) => {
    const jobId = '22222222-2222-4222-8222-222222222222';
    await page.route(`**/api/ai-research/${jobId}`, (route) => route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        jobId,
        status: 'succeeded',
        finalStatus: 'succeeded',
        currentStep: 'write',
        topic: '比较三种网页抓取方案',
        sourcesCount: 3,
        savedSourcesCount: 3,
        partialSourcesCount: 3,
        failedSourcesCount: 0,
        userSourceRefsCount: 0,
        autoSourceRefsCount: 3,
        reportType: 'slides',
        reportLength: 'standard',
        deliverableStatus: 'report',
        sourcePolicy: 'prefer_user_sources',
        researchProgress: null,
        outputText: null,
        errorCode: null,
        errorMessage: null,
        errorDetails: null,
        startedAt: '2026-09-04T04:00:00.000Z',
        createdAt: '2026-09-04T04:00:00.000Z',
        completedAt: '2026-09-04T04:01:00.000Z',
        draftResearchId: '33333333-3333-4333-8333-333333333333',
        review: { phase: 'completed', status: 'passed', attempts: 1, corrected_count: 0, unverified_count: 0, contradicted_count: 0, claims: [] },
        conversation: [],
        sources: [],
        artifact: {
          type: 'slides',
          title: '网页抓取方案选型',
          version: 1,
          mimeType: 'text/markdown',
          content: '## Slide 1: 判断\n\n先验证目标。\n\n## Slide 2: 证据\n\n官方资料。\n\n## Slide 3: 行动\n\n运行灰度。',
          rawContent: null,
          payload: null,
          sourceRefs: [],
          sourceHash: null,
          draftResearchId: '33333333-3333-4333-8333-333333333333',
        },
      }),
    }));
    await page.route(`**/api/ai-research/conversations/by-job/${jobId}`, (route) => route.fulfill({ status: 404, body: 'not found' }));
    await page.goto(`/ai-research/${jobId}`);
    await expect(page.getByText('Slides 提纲已生成，可继续编辑或追问。')).toBeVisible();
    await expect(page.getByLabel('Slides 提纲预览')).toHaveCount(1);
    await expect(page.getByText('3 页', { exact: true })).toBeVisible();
    await expect(page.getByRole('link', { name: '编辑 Slides 提纲' })).toBeVisible();
  });

  test('brief without captured evidence is not presented as verified research', async ({ page }) => {
    const jobId = '44444444-4444-4444-8444-444444444444';
    await page.route(`**/api/ai-research/${jobId}`, (route) => route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        jobId,
        status: 'succeeded',
        finalStatus: 'succeeded',
        currentStep: 'write',
        topic: '没有资料的快速简报',
        sourcesCount: 0,
        savedSourcesCount: 0,
        partialSourcesCount: 0,
        failedSourcesCount: 0,
        userSourceRefsCount: 0,
        autoSourceRefsCount: 0,
        reportType: 'summary_brief',
        reportLength: 'brief',
        deliverableStatus: 'report',
        sourcePolicy: 'prefer_user_sources',
        researchProgress: null,
        outputText: null,
        errorCode: null,
        errorMessage: null,
        errorDetails: null,
        startedAt: '2026-09-04T04:00:00.000Z',
        createdAt: '2026-09-04T04:00:00.000Z',
        completedAt: '2026-09-04T04:00:06.000Z',
        draftResearchId: null,
        review: null,
        conversation: [],
        sources: [],
        artifact: {
          type: 'markdown',
          title: '没有资料的快速简报',
          version: 1,
          mimeType: 'text/markdown',
          content: '这是一个没有来源的模型摘录。',
          rawContent: null,
          payload: null,
          sourceRefs: [],
          sourceHash: null,
          draftResearchId: null,
        },
      }),
    }));
    await page.route(`**/api/ai-research/conversations/by-job/${jobId}`, (route) => route.fulfill({ status: 404, body: 'not found' }));
    await page.goto(`/ai-research/${jobId}`);
    await expect(page.getByRole('heading', { name: '快速判断已生成，但未找到资料' })).toBeVisible();
    await expect(page.getByText('无证据', { exact: true })).toBeVisible();
    await expect(page.getByText('仅模型摘录', { exact: true })).toBeVisible();
    // 研究步骤默认收在“查看研究详情”里；先展开再断言摘要步骤。
    await page.getByText('查看研究详情', { exact: true }).click();
    await expect(page.getByText('生成摘要', { exact: true })).toBeVisible();
    await expect(page.getByText('本轮未保存可核对资料')).toBeVisible();
    await expect(page.getByText('100%', { exact: true })).toHaveCount(0);
  });
});
