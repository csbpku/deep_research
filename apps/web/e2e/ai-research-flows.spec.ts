// AI 调研流程 E2E
//
// 覆盖：
//   - AI 调研对话页加载
//   - 对话输入和发送按钮
//   - 详情页：刷新按钮、重试入口、statusLabel 本地化
//   - 父页：EmptyState 错误 / 空态、产物确认卡片

import { test, expect } from '@playwright/test';
import { PrismaClient } from '@prisma/client';
import { createHash, randomUUID } from 'node:crypto';
import { loginWithCredentials } from './fixtures';

const prisma = new PrismaClient();

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
      email: 'member@e2e.local',
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

  test('knowledge card save keeps the exact judgment used to generate its preview', async ({ page }) => {
    await loginWithCredentials(page.context().request, {
      email: 'e2e-admin@e2e.local',
      role: 'admin',
    });
    const jobId = '77777777-7777-4777-8777-777777777777';
    const researchId = '88888888-8888-4888-8888-888888888888';
    const firstJudgment = '结论 A：在过载时保持幂等重试。';
    const secondJudgment = '结论 B：不要重复写入索引文档。';
    let derivePayload: Record<string, unknown> | null = null;
    let savePayload: Record<string, unknown> | null = null;
    const artifact = `${firstJudgment}\n\n${secondJudgment}`;

    await page.route(`**/api/ai-research/${jobId}`, (route) => route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        jobId,
        status: 'succeeded',
        finalStatus: 'succeeded',
        currentStep: 'write',
        topic: '幂等研究',
        sourcesCount: 1,
        savedSourcesCount: 1,
        partialSourcesCount: 0,
        failedSourcesCount: 0,
        userSourceRefsCount: 0,
        autoSourceRefsCount: 1,
        reportType: 'research_report',
        reportLength: 'standard',
        deliverableStatus: 'report',
        sourcePolicy: 'prefer_user_sources',
        researchProgress: null,
        outputText: null,
        errorCode: null,
        errorMessage: null,
        errorDetails: null,
        startedAt: '2026-09-24T04:00:00.000Z',
        createdAt: '2026-09-24T04:00:00.000Z',
        completedAt: '2026-09-24T04:01:00.000Z',
        draftResearchId: researchId,
        review: { phase: 'completed', status: 'passed', attempts: 1, corrected_count: 0, unverified_count: 0, contradicted_count: 0, claims: [] },
        conversation: [],
        sources: [],
        artifact: {
          type: 'markdown',
          title: '幂等研究',
          version: 1,
          mimeType: 'text/markdown',
          content: artifact,
          rawContent: null,
          payload: null,
          sourceRefs: [],
          sourceHash: null,
          draftResearchId: researchId,
        },
      }),
    }));
    await page.route(`**/api/ai-research/conversations/by-job/${jobId}`, (route) =>
      route.fulfill({ status: 404, body: 'not found' }),
    );
    await page.route('**/api/knowledge/derive', async (route) => {
      derivePayload = route.request().postDataJSON() as Record<string, unknown>;
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          preview: { title: '幂等判断', body: '过载时按幂等键执行有界重试。', conclusion: '重试必须幂等。', tags: [] },
        }),
      });
    });
    await page.route('**/api/knowledge', async (route) => {
      savePayload = route.request().postDataJSON() as Record<string, unknown>;
      await route.fulfill({
        status: 201,
        contentType: 'application/json',
        body: JSON.stringify({ knowledge: { id: '99999999-9999-4999-8999-999999999999', status: 'draft' } }),
      });
    });

    await page.goto(`/ai-research/${jobId}`);
    const source = page.locator(`[data-knowledge-source-message="${researchId}"]`);
    await expect(source).toContainText(secondJudgment);
    const selectSourceText = async (text: string) => {
      await source.evaluate((root, selected) => {
        const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
        let node: Node | null;
        while ((node = walker.nextNode())) {
          const value = node.textContent ?? '';
          const start = value.indexOf(selected);
          if (start < 0) continue;
          const range = document.createRange();
          range.setStart(node, start);
          range.setEnd(node, start + selected.length);
          const selection = window.getSelection();
          selection?.removeAllRanges();
          selection?.addRange(range);
          document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
          return;
        }
        throw new Error(`Could not select report text: ${selected}`);
      }, text);
    };

    await selectSourceText(firstJudgment);
    await page.getByRole('button', { name: '存为知识' }).click();
    await expect(page.getByText('知识卡片预览')).toBeVisible();
    await expect(page.getByLabel('本次提炼所选原文')).toContainText(firstJudgment);
    expect(derivePayload?.selectedText).toBe(firstJudgment);

    await selectSourceText(secondJudgment);
    await expect(page.getByLabel('本次提炼所选原文')).toContainText(firstJudgment);
    await page.getByRole('button', { name: '保存知识卡片' }).click();
    await expect(page.getByText('已保存知识卡片')).toBeVisible();
    expect(savePayload?.selectedText).toBe(firstJudgment);
  });

  test('follow-up report revision sends only the persisted answer ID and cancel is inert', async ({ page }) => {
    await loginWithCredentials(page.context().request, {
      email: 'e2e-admin@e2e.local',
      role: 'admin',
    });
    const jobId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    const reportId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
    const answerId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
    let revisionPayload: Record<string, unknown> | null = null;

    await page.route(`**/api/ai-research/${jobId}`, (route) => route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        jobId,
        status: 'succeeded',
        finalStatus: 'succeeded',
        currentStep: 'write',
        topic: '幂等索引调研',
        sourcesCount: 1,
        savedSourcesCount: 1,
        partialSourcesCount: 0,
        failedSourcesCount: 0,
        userSourceRefsCount: 0,
        autoSourceRefsCount: 1,
        reportType: 'research_report',
        reportLength: 'standard',
        deliverableStatus: 'report',
        sourcePolicy: 'prefer_user_sources',
        researchProgress: null,
        outputText: null,
        errorCode: null,
        errorMessage: null,
        errorDetails: null,
        startedAt: '2026-09-28T04:00:00.000Z',
        createdAt: '2026-09-28T04:00:00.000Z',
        completedAt: '2026-09-28T04:01:00.000Z',
        draftResearchId: reportId,
        review: { phase: 'completed', status: 'passed', attempts: 1, corrected_count: 0, unverified_count: 0, contradicted_count: 0, claims: [] },
        conversation: [],
        sources: [],
        artifact: {
          type: 'markdown',
          title: '幂等索引调研',
          version: 1,
          mimeType: 'text/markdown',
          content: '旧报告正文。',
          rawContent: '旧报告正文。',
          payload: null,
          sourceRefs: [],
          sourceHash: null,
          draftResearchId: reportId,
        },
      }),
    }));
    await page.route(`**/api/ai-research/conversations/by-job/${jobId}`, (route) => route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        id: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
        jobId,
        title: '幂等索引调研',
        status: 'active',
        messageCount: 2,
        createdAt: '2026-09-28T04:00:00.000Z',
        updatedAt: '2026-09-28T04:01:00.000Z',
        messages: [
          { id: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee', role: 'user', content: '补充重试边界', createdAt: '2026-09-28T04:00:30.000Z', intent: 'revise' },
          { id: answerId, role: 'assistant', content: '在事务提交后重试，并使用稳定幂等键。', createdAt: '2026-09-28T04:01:00.000Z', intent: 'revise' },
        ],
      }),
    }));
    await page.route(`**/api/researches/${reportId}`, async (route) => {
      if (route.request().method() !== 'PUT') return route.continue();
      revisionPayload = route.request().postDataJSON() as Record<string, unknown>;
      await route.fulfill({ status: 200, contentType: 'application/json', body: '{}' });
    });

    await page.goto(`/ai-research/${jobId}`);
    const applyButton = page.getByRole('button', { name: '应用到报告 · 先预览变更' });
    await expect(applyButton).toBeVisible();
    await applyButton.click();
    await expect(page.getByText('应用为报告新版本？')).toBeVisible();
    await page.getByRole('button', { name: '取消', exact: true }).click();
    await expect(page.getByText('应用为报告新版本？')).toHaveCount(0);
    expect(revisionPayload).toBeNull();

    await applyButton.click();
    await page.getByRole('button', { name: '确认生成新版本' }).click();
    await expect(page.getByText('已生成新版本 · 可在编辑器的版本历史中恢复')).toBeVisible();
    expect(revisionPayload).toEqual({ revisionContext: { sourceMessageId: answerId } });
  });

  test('follow-up report revision persists through the real API and appears in version history', async ({ page }) => {
    const adminEmail = 'e2e-admin@e2e.local';
    await loginWithCredentials(page.context().request, { email: adminEmail, role: 'admin' });
    const admin = await prisma.user.findUnique({ where: { email: adminEmail }, select: { id: true } });
    expect(admin).not.toBeNull();

    const jobId = randomUUID();
    const reportId = randomUUID();
    const conversationId = randomUUID();
    const questionId = randomUUID();
    const answerId = randomUUID();
    const title = `E2E report revision ${randomUUID().slice(0, 8)}`;
    const originalBody = 'Synthetic original report body.';
    const question = '补充部署失败时的回滚边界';
    const answer = '先停止新流量并恢复兼容版本；不要改写已经发布的迁移历史。';

    try {
      await prisma.research.create({
        data: {
          id: reportId,
          type: 'research',
          status: 'draft',
          title,
          body: originalBody,
          authorId: admin!.id,
          aiAssisted: true,
          creationMethod: 'ai_research',
          originContentSha256: createHash('sha256').update(originalBody).digest('hex'),
        },
      });
      await prisma.aiResearchJob.create({
        data: {
          id: jobId,
          requesterId: admin!.id,
          topic: title,
          status: 'succeeded',
          completedAt: new Date(),
          draftResearchId: reportId,
          partialSources: [{
            source_ref: { type: 'url', value: 'https://example.com/e2e-report-revision' },
            canonical_key: 'https://example.com/e2e-report-revision',
            title: 'Synthetic E2E source',
            snippet: 'Synthetic source snapshot for the report revision flow.',
            score: 1,
            step_captured: 'search',
          }],
        },
      });
      await prisma.aiResearchConversation.create({
        data: {
          id: conversationId,
          userId: admin!.id,
          jobId,
          title,
          messages: {
            create: [
              { id: questionId, role: 'user', content: question, intent: 'revise' },
              { id: answerId, role: 'assistant', content: answer, intent: 'revise' },
            ],
          },
        },
      });

      await page.route(`**/api/ai-research/${jobId}`, (route) => route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          jobId,
          status: 'succeeded',
          finalStatus: 'succeeded',
          currentStep: 'write',
          topic: title,
          sourcesCount: 0,
          savedSourcesCount: 0,
          partialSourcesCount: 0,
          failedSourcesCount: 0,
          userSourceRefsCount: 0,
          autoSourceRefsCount: 0,
          reportType: 'research_report',
          reportLength: 'standard',
          deliverableStatus: 'report',
          sourcePolicy: 'prefer_user_sources',
          researchProgress: null,
          outputText: null,
          errorCode: null,
          errorMessage: null,
          errorDetails: null,
          startedAt: new Date().toISOString(),
          createdAt: new Date().toISOString(),
          completedAt: new Date().toISOString(),
          draftResearchId: reportId,
          review: { phase: 'completed', status: 'passed', attempts: 1, corrected_count: 0, unverified_count: 0, contradicted_count: 0, claims: [] },
          conversation: [],
          sources: [],
          artifact: {
            type: 'markdown',
            title,
            version: 1,
            mimeType: 'text/markdown',
            content: originalBody,
            rawContent: originalBody,
            payload: null,
            sourceRefs: [],
            sourceHash: null,
            draftResearchId: reportId,
          },
        }),
      }));
      await page.route(`**/api/ai-research/conversations/by-job/${jobId}`, (route) => route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          id: conversationId,
          jobId,
          title,
          status: 'active',
          messageCount: 2,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          messages: [
            { id: questionId, role: 'user', content: question, createdAt: new Date().toISOString(), intent: 'revise' },
            { id: answerId, role: 'assistant', content: answer, createdAt: new Date().toISOString(), intent: 'revise' },
          ],
        }),
      }));

      await page.goto(`/ai-research/${jobId}`);
      const applyButton = page.getByRole('button', { name: '应用到报告 · 先预览变更' });
      await expect(applyButton).toBeVisible();
      await applyButton.click();
      await expect(page.getByText('应用为报告新版本？')).toBeVisible();
      await page.getByRole('button', { name: '取消', exact: true }).click();
      await expect(page.getByText('应用为报告新版本？')).toHaveCount(0);
      expect(await prisma.research.findUnique({ where: { id: reportId }, select: { body: true } }))
        .toEqual({ body: originalBody });
      expect(await prisma.researchAudit.count({ where: { researchId: reportId } })).toBe(0);

      await applyButton.click();
      const savedRevision = page.waitForResponse((response) =>
        new URL(response.url()).pathname === `/api/researches/${reportId}` &&
        response.request().method() === 'PUT',
      );
      await page.getByRole('button', { name: '确认生成新版本' }).click();
      expect((await savedRevision).status()).toBe(200);
      await expect(page.getByText('已生成新版本 · 可在编辑器的版本历史中恢复')).toBeVisible();

      const updated = await prisma.research.findUnique({ where: { id: reportId }, select: { body: true } });
      expect(updated?.body).toContain(originalBody);
      expect(updated?.body).toContain('## 追问补充');
      expect(updated?.body).toContain(question);
      expect(updated?.body).toContain(answer);
      const audit = await prisma.researchAudit.findFirst({
        where: { researchId: reportId, sourceMessageId: answerId },
        select: { action: true, sourceIntent: true, sourceQuestion: true, prevSnapshot: true },
      });
      expect(audit).toMatchObject({ action: 'edit', sourceIntent: 'revise', sourceQuestion: question });
      expect(audit?.prevSnapshot).toMatchObject({ body: originalBody });

      await page.goto(`/researches/${reportId}/edit`);
      await page.getByRole('tab', { name: '版本历史' }).click();
      const history = page.getByRole('tabpanel', { name: '版本历史' });
      await expect(history.getByText('来自追问修订')).toBeVisible();
      await expect(history).toContainText(question);
    } finally {
      await prisma.aiResearchConversation.deleteMany({ where: { id: conversationId } });
      await prisma.aiResearchJob.deleteMany({ where: { id: jobId } });
      await prisma.research.deleteMany({ where: { id: reportId } });
    }
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
