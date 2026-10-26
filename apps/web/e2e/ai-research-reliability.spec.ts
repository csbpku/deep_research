import { expect, test } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import { loginWithCredentials } from './fixtures';

test('database transcript writes stay ordered across concurrent batches', async ({ request }) => {
  await loginWithCredentials(request, { email: 'member@e2e.local', role: 'member' });
  const created = await request.post('/api/ai-research/conversations', { data: {
    title: 'Transcript ordering regression',
    messages: [
      { role: 'assistant', content: 'Welcome' },
      { role: 'user', content: 'Grok Bot' },
      { role: 'assistant', content: 'Ready' },
    ],
  } });
  expect(created.status()).toBe(201);
  const { id } = await created.json() as { id: string };
  const prisma = new PrismaClient();
  try {
    const responses = await Promise.all(Array.from({ length: 4 }, (_, index) => (
      request.post(`/api/ai-research/conversations/${id}/messages`, { data: { messages: [
        { role: 'user', content: `Question ${index}` },
        { role: 'assistant', content: `Answer ${index}` },
      ] } })
    )));
    expect(responses.every((response) => response.ok())).toBe(true);
    const restored = await request.get(`/api/ai-research/conversations/${id}`);
    const { messages } = await restored.json() as { messages: Array<{ content: string; createdAt: string }> };
    expect(messages.map((message) => message.content).slice(0, 3)).toEqual(['Welcome', 'Grok Bot', 'Ready']);
    expect(messages).toHaveLength(11);
    for (let index = 1; index < messages.length; index++) {
      expect(Date.parse(messages[index]!.createdAt)).toBeGreaterThan(Date.parse(messages[index - 1]!.createdAt));
    }
    for (let index = 0; index < 4; index++) {
      const questionIndex = messages.findIndex((message) => message.content === `Question ${index}`);
      expect(messages[questionIndex + 1]!.content).toBe(`Answer ${index}`);
    }
  } finally {
    await prisma.aiResearchConversation.delete({ where: { id } });
    await prisma.$disconnect();
  }
});

for (const viewport of [{ width: 1440, height: 1000 }, { width: 390, height: 844 }]) {
  test(`learning conversation stays ordered and planning settles at ${viewport.width}px`, async ({ page }) => {
    await page.setViewportSize(viewport);
    const conversationId = randomUUID();
    const topicId = randomUUID();
    const question = '我想学习一下grok bot';
    let planCalls = 0;
    let contextCalls = 0;
    let appendCalls = 0;
    let releaseAppend!: () => void;
    const firstAppend = new Promise<void>((resolve) => { releaseAppend = resolve; });
    let submitted: Record<string, unknown> | undefined;
    let transcript: Array<{ id: string; role: string; content: string; createdAt: string }> = [];
    const conversation = () => ({
      id: conversationId, title: question, jobId: null, status: 'active',
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
      messageCount: transcript.length, messages: transcript,
    });
    await page.route('**/api/ai-research/conversations*', async (route) => {
      if (route.request().method() === 'POST') {
        const input = route.request().postDataJSON() as { messages: typeof transcript };
        transcript = input.messages.map((message, index) => ({
          ...message, id: randomUUID(), createdAt: new Date(Date.now() + index).toISOString(),
        }));
        return route.fulfill({ status: 201, json: conversation() });
      }
      return route.fulfill({ json: { items: [] } });
    });
    await page.route(`**/api/ai-research/conversations/${conversationId}`, (route) => (
      route.fulfill({ json: conversation() })
    ));
    await page.route(`**/api/ai-research/conversations/${conversationId}/messages`, async (route) => {
      appendCalls++;
      if (appendCalls === 1) await firstAppend;
      const input = route.request().postDataJSON() as { messages: typeof transcript };
      transcript.push(...input.messages.map((message) => ({
        ...message, id: randomUUID(), createdAt: new Date().toISOString(),
      })));
      return route.fulfill({ json: conversation() });
    });
    await page.route('**/api/ai-research/jobs*', (route) => (
      route.fulfill({ json: { items: [], total: 0, limit: 50, offset: 0 } })
    ));
    await page.route('**/api/ai-research/context?*', (route) => {
      contextCalls++;
      return route.fulfill({ json: { items: [] } });
    });
    await page.route('**/api/ai-research/plan', (route) => {
      planCalls++;
      return route.fulfill({ json: {
        assistantMessage: '学习计划已准备好', ready: true, missingFields: [],
        suggestedTopics: [{ topicId, slug: 'grok', name: 'Grok', confidence: 1 }],
        suggestedContext: [],
        brief: {
          question, objective: 'learn', primaryTopicId: topicId,
          questionsToAnswer: ['概念和入门路径'], constraints: [], comparisonOptions: [],
          decisionDimensions: [], successCriteria: [], contextRefs: [],
          outputType: 'markdown', sourcePolicy: 'prefer_user_sources',
          scope: { timeRange: { preset: 'any' }, regions: [], technologyVersions: [], retrievalNotes: '' },
        },
      } });
    });
    await page.route('**/api/ai-research', (route) => {
      submitted = route.request().postDataJSON() as Record<string, unknown>;
      // Do not start a real paid research job in this browser regression.
      return route.fulfill({ status: 503, json: { code: 'AI_ENGINE_UNAVAILABLE', message: 'fixture' } });
    });
    await page.goto('/ai-research');
    await page.getByRole('textbox', { name: 'AI 调研对话输入' }).fill(question);
    await page.getByRole('button', { name: '发送消息（AI 调研）' }).click();
    await expect(page).toHaveURL(new RegExp(`conversation=${conversationId}`));
    const chat = page.getByRole('region', { name: 'AI 调研对话', exact: true });
    await expect(chat).not.toContainText('没能确定具体的调研对象');
    await expect(chat).not.toContainText('这份调研将支持什么决策');
    const assertOrder = async () => {
      const text = await chat.innerText();
      expect(text.indexOf('告诉我你想弄清楚的问题')).toBeLessThan(text.indexOf(question));
      expect(text.indexOf(question)).toBeLessThan(text.indexOf('我会围绕'));
    };
    await assertOrder();
    const focus = page.getByRole('textbox', { name: '重点回答' });
    await expect(focus).toHaveValue('概念和入门路径');
    await focus.fill('先讲概念，再给入门示例');
    await expect(chat.getByRole('status').filter({ hasText: '正在查找相关资料' })).toHaveCount(0);
    await page.waitForTimeout(1600);
    expect(planCalls).toBe(1);
    expect(contextCalls).toBe(1);
    await expect(focus).toHaveValue('先讲概念，再给入门示例');
    const composer = page.getByRole('textbox', { name: 'AI 调研对话输入' });
    await composer.fill('先解释工作原理');
    await page.getByRole('button', { name: '发送消息（AI 调研）' }).click();
    await expect.poll(() => appendCalls).toBe(1);
    await composer.fill('再给使用示例');
    await page.getByRole('button', { name: '发送消息（AI 调研）' }).click();
    await page.waitForTimeout(150);
    expect(appendCalls).toBe(1);
    releaseAppend();
    await expect.poll(() => appendCalls).toBe(2);
    await chat.getByText(/^我会围绕/u).scrollIntoViewIfNeeded();
    await page.screenshot({ path: `test-results/research-reliability-${viewport.width}.png`, fullPage: true });
    await page.getByRole('button', { name: '开始调研', exact: true }).click();
    await expect.poll(() => submitted?.primaryTopicId).toBe(topicId);
    expect((submitted?.brief as { questionsToAnswer: string[] }).questionsToAnswer)
      .toEqual(['先讲概念，再给入门示例']);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await page.reload();
    await expect(page.getByRole('textbox', { name: '重点回答' })).toBeVisible();
    await assertOrder();
    const restored = await chat.innerText();
    expect(restored.indexOf('先解释工作原理')).toBeLessThan(restored.indexOf('再给使用示例'));
  });
}
