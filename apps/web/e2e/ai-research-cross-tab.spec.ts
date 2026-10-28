import { expect, test } from '@playwright/test';

const owner = '11111111-1111-4111-8111-111111111111';
const conversationId = '22222222-2222-4222-8222-222222222222';
const jobId = '33333333-3333-4333-8333-333333333333';
const question = '比较 Playwright 和 Cypress 的工程取舍';

for (const outcome of ['success', 'unknown'] as const) test(`${outcome}: a stale second tab cannot start the same conversation twice`, async ({ context, page }) => {
  let submissions = 0;
  const conversation = { id: conversationId, userId: owner, title: question, jobId: null, status: 'active', messageCount: 3, createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z', messages: [
    { id: 'm1', role: 'assistant', content: '告诉我你的问题。' }, { id: 'm2', role: 'user', content: question }, { id: 'm3', role: 'assistant', content: '主题已明确。' },
  ] };
  await context.route('**/api/**', route => route.fulfill({ json: {} }));
  await context.route('**/api/auth/session', route => route.fulfill({ json: { user: { id: owner, role: 'member' }, expires: '2099-01-01' } }));
  await context.route('**/api/ai-research/jobs*', route => route.fulfill({ json: { items: [], total: 0 } }));
  await context.route('**/api/ai-research/conversations*', route => route.fulfill({ json: { items: [] } }));
  await context.route(`**/api/ai-research/conversations/${conversationId}`, route => route.fulfill({ json: conversation }));
  await context.route('**/api/ai-research/context?*', route => route.fulfill({ json: { items: [] } }));
  await context.route('**/api/ai-research/plan', route => route.fulfill({ json: { assistantMessage: '已准备', ready: true, missingFields: [], suggestedTopics: [], suggestedContext: [], brief: {
    question, objective: 'decide', questionsToAnswer: ['成本'], comparisonOptions: ['Playwright', 'Cypress'], decisionDimensions: ['成本'], constraints: [], successCriteria: [], contextRefs: [], outputType: 'markdown', sourcePolicy: 'prefer_user_sources', scope: { timeRange: { preset: 'any' }, regions: [], technologyVersions: [], retrievalNotes: '' },
  } } }));
  await context.route(`**/api/ai-research/${jobId}`, route => route.fulfill({ json: { jobId, status: 'queued' } }));
  await context.route('**/api/ai-research', route => { submissions++; return outcome === 'success' ? route.fulfill({ status: 202, json: { jobId } }) : route.fulfill({ status: 503, json: { message: '结果未知' } }); });
  const stale = await context.newPage();
  // A suspended tab may miss storage events; the lock still has to check durable state.
  await stale.addInitScript(() => window.addEventListener('storage', event => event.stopImmediatePropagation(), true));
  await Promise.all([page.goto(`/ai-research?conversation=${conversationId}`), stale.goto(`/ai-research?conversation=${conversationId}`)]);
  const first = page.getByRole('button', { name: '开始调研', exact: true });
  const second = stale.getByRole('button', { name: '开始调研', exact: true });
  await expect(first).toBeEnabled(); await expect(second).toBeEnabled();
  await first.click();
  if (outcome === 'success') await expect(page.getByRole('link', { name: /打开完整任务/ })).toBeVisible();
  else await expect(page.getByRole('link', { name: /查看任务历史/ })).toBeVisible();
  await second.click();
  if (outcome === 'success') await expect(stale.getByRole('link', { name: /打开完整任务/ })).toBeVisible();
  else {
    await expect(stale.getByRole('link', { name: /查看任务历史/ })).toBeVisible();
    await stale.getByRole('button', { name: '已核对历史，允许重新提交' }).click();
    await expect(second).toBeEnabled();
  }
  expect(submissions).toBe(1);
});
