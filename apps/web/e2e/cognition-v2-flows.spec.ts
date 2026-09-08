// 认知闭环 V2 E2E（ADR 0010）
//
// 覆盖：
//   - /topics 顶部筛选芯片切换
//   - /topics/[slug] 4 标签切换（概览 / 热点议题 / 相关研究 / 来源）
//   - AI 调研页 brief 自动注入（带建议主题时出现 Research Brief 卡片）
//
// 跑测约定：web 服务以 E2E=1 启动并登录 E2E 账号；专题详情为服务端渲染，
// 因而只断言稳定的 UI 契约，不依赖某条真实综述内容是否已生成。

import { test, expect } from '@playwright/test';
import { loginWithCredentials } from './fixtures';

test.describe('Topics list filter chips (V2)', () => {
  test('filter chips are present and clicking changes the URL', async ({ page }) => {
    await loginWithCredentials(page.context().request, {
      email: 'member@shopee.com',
      role: 'member',
    });
    await page.goto('/topics');
    // 筛选区现在是链接导航（aria-current 标记激活项），不再是 Radix tabs
    const filterNav = page.getByRole('navigation', { name: '专题筛选' });
    await expect(filterNav.getByRole('link', { name: '全部专题' })).toBeVisible();
    await expect(filterNav.getByRole('link', { name: '热门' })).toBeVisible();
    await expect(filterNav.getByRole('link', { name: '升温' })).toBeVisible();
    await expect(filterNav.getByRole('link', { name: '新出现' })).toBeVisible();
    await expect(filterNav.getByRole('link', { name: '只看已关注' })).toBeVisible();

    await filterNav.getByRole('link', { name: '热门' }).click();
    await expect(page).toHaveURL(/filter=hot/);
    await expect(filterNav.getByRole('link', { name: '热门' })).toHaveAttribute('aria-current', 'page');

    await filterNav.getByRole('link', { name: '升温' }).click();
    await expect(page).toHaveURL(/filter=warming/);
  });
});

test.describe('Topic detail 4-tab view (V2)', () => {
  test('tabs 概览 / 热点议题 / 相关研究 / 相关内容 are present and switchable', async ({ page }) => {
    await loginWithCredentials(page.context().request, {
      email: 'member@shopee.com',
      role: 'member',
    });
    await page.route('**/api/topics/ai-agents**', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          id: 'b84dbb4c-ec77-4c25-8699-746bd2d550fc',
          slug: 'ai-agents',
          name: 'AI Agents',
          summary: 'AI agent frameworks and orchestration patterns.',
          tier: 'hot',
          candidateCount: 1,
          sourceCount: 1,
          aggregationWindowStart: new Date(Date.now() - 14 * 24 * 3600 * 1000).toISOString(),
          aggregationWindowEnd: new Date().toISOString(),
          lastSyncedAt: new Date().toISOString(),
          synthesisPayload: {
            tldr: '一句话概要',
            keyChanges: [{ title: '关键变化 1', whyItMatters: '为什么重要', summaryIds: [] }],
            subtopics: [{ title: '子方向', summary: '简述' }],
            openQuestions: ['仍然开放的问题'],
            sections: [{ title: '深度阅读', content: '段落内容', summaryIds: [] }],
            references: [],
          },
          synthesisErrorCode: null,
          synthesisErrorMessage: null,
          lastSynthesisSuccessAt: new Date().toISOString(),
        }),
      }),
    );
    await page.route('**/api/topics/ai-agents/issues**', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ issues: [] }),
      }),
    );

    await page.goto('/topics/ai-agents');
    await expect(page.getByRole('tab', { name: /概览/ })).toBeVisible();
    await expect(page.getByRole('tab', { name: /热点议题/ })).toBeVisible();
    await expect(page.getByRole('tab', { name: /相关研究/ })).toBeVisible();
    await expect(page.getByRole('tab', { name: /相关内容/ })).toBeVisible();

    // 默认进入"概览"
    await expect(page.getByRole('tab', { name: /概览/ })).toHaveAttribute('aria-selected', 'true');
    // 服务端数据可能处于“综述生成中”，但概览面板本身必须稳定可见。
    await expect(page.getByRole('heading', { name: /^(一句话概要|AI 综述)$/ })).toBeVisible();

    // 切到"热点议题"
    await page.getByRole('tab', { name: /热点议题/ }).click();
    await expect(page.getByRole('tab', { name: /热点议题/ })).toHaveAttribute('aria-selected', 'true');

    // 切到"相关研究"
    await page.getByRole('tab', { name: /相关研究/ }).click();
    await expect(page.getByRole('tab', { name: /相关研究/ })).toHaveAttribute('aria-selected', 'true');

    // 切到"相关内容"
    await page.getByRole('tab', { name: /相关内容/ }).click();
    await expect(page.getByRole('tab', { name: /相关内容/ })).toHaveAttribute('aria-selected', 'true');
  });
});

test.describe('AI Research V2 brief', () => {
  test('conversation page shows Research Brief section after topic is set', async ({ page }) => {
    await loginWithCredentials(page.context().request, {
      email: 'member@shopee.com',
      role: 'member',
    });

    await page.route('**/api/ai-research/plan', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          assistantMessage: '这是快速概览，可以直接启动。',
          brief: {
            objective: 'explore',
            question: '研究 GraphRAG',
            constraints: [],
            questionsToAnswer: [],
            comparisonOptions: [],
            successCriteria: [],
            sourcePolicy: 'prefer_user_sources',
            contextRefs: [],
            primaryTopicId: null,
            outputType: 'markdown',
          },
          plan: {
            summary: '围绕 GraphRAG 快速梳理形态与动向。',
            steps: [],
            estimatedMinutes: 5,
          },
          ready: true,
          missingFields: [],
          suggestedTopics: [
            { topicId: 'b84dbb4c-ec77-4c25-8699-746bd2d550fc', slug: 'ai-agents', name: 'AI Agents', confidence: 0.6 },
          ],
          suggestedContext: [],
        }),
      }),
    );

    await page.route('**/api/ai-research', (route) => {
      if (route.request().method() !== 'POST') return route.continue();
      const body = route.request().postDataJSON();
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ jobId: '22222222-2222-4222-8222-222222222222' }),
      });
    });

    await page.goto('/ai-research');
    const input = page.getByRole('textbox', { name: 'AI 调研对话输入' });
    await input.fill('研究 GraphRAG');
    await page.getByRole('button', { name: '发送消息' }).click();
    await input.fill('补充背景');
    await page.getByRole('button', { name: '发送消息' }).click();

    // Brief 卡片应出现
    await expect(page.getByText('研究计划', { exact: true })).toBeVisible({ timeout: 5000 });
    await expect(page.getByRole('button', { name: '快速概览', exact: true })).toBeVisible();
  });
});
