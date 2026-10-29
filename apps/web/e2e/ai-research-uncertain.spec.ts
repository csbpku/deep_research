import { expect, test } from '@playwright/test';

const conversationId = '22222222-2222-4222-8222-222222222222';
const userId = '11111111-1111-4111-8111-111111111111';
const question = '比较 Playwright 和 Cypress 的工程取舍';

for (const failure of ['server-error', 'network-disconnect'] as const) test(`${failure}: uncertain submission remains locked after reload until history is checked`, async ({ page }) => {
  let submissions = 0;
  const conversation = { id: conversationId, userId, title: question, jobId: null, status: 'active', messageCount: 3,
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), messages: [
      { id: 'm1', role: 'assistant', content: '告诉我你想弄清楚的问题。' },
      { id: 'm2', role: 'user', content: question },
      { id: 'm3', role: 'assistant', content: '可以直接开始。' },
    ] };
  await page.route('**/api/ai-research/conversations*', route => route.fulfill({ json: { items: [] } }));
  await page.route(`**/api/ai-research/conversations/${conversationId}`, route => route.fulfill({ json: conversation }));
  await page.route('**/api/ai-research/jobs*', route => route.fulfill({ json: { items: [], total: 0 } }));
  await page.route('**/api/ai-research/context?*', route => route.fulfill({ json: { items: [] } }));
  await page.route('**/api/ai-research/plan', route => route.fulfill({ json: { assistantMessage: '已准备', ready: true, missingFields: [], suggestedTopics: [], suggestedContext: [], brief: {
    question, objective: 'decide', questionsToAnswer: ['成本'], comparisonOptions: ['Playwright', 'Cypress'], decisionDimensions: ['成本与资源'], constraints: [], successCriteria: [], contextRefs: [], outputType: 'markdown', sourcePolicy: 'prefer_user_sources', scope: { timeRange: { preset: 'any' }, regions: [], technologyVersions: [], retrievalNotes: '' },
  } } }));
  await page.route('**/api/ai-research', route => { submissions++; return failure === 'network-disconnect' ? route.abort('connectionreset') : route.fulfill({ status: 503, json: { code: 'AI_ENGINE_UNAVAILABLE', message: '结果未知' } }); });
  await page.goto(`/ai-research?conversation=${conversationId}`);
  const start = page.getByRole('button', { name: '开始调研', exact: true });
  await expect(start).toBeEnabled();
  await start.click();
  await expect(page.getByRole('link', { name: /查看任务历史/ })).toBeVisible();
  expect(submissions).toBe(1);
  await page.reload();
  await expect(start).toBeDisabled();
  await expect(page.getByRole('link', { name: /查看任务历史/ })).toBeVisible();
  expect(submissions).toBe(1);
  await page.getByRole('button', { name: '已核对历史，允许重新提交' }).click();
  await expect(start).toBeEnabled();
});
