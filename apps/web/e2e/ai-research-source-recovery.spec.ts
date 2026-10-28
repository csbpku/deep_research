import { expect, test, type Page } from '@playwright/test';

const userId = 'f0500000-0000-4000-8000-000000000008';
const conversationId = 'f0500000-0000-4000-8000-000000000009';
const issueId = 'f0500000-0000-4000-8000-000000000010';
const bookmarkId = 'f0500000-0000-4000-8000-000000000011';
const summaryId = 'f0500000-0000-4000-8000-000000000012';
const researchId = 'f0500000-0000-4000-8000-000000000013';
const jobId = 'f0500000-0000-4000-8000-000000000014';
const question = '比较 Playwright 和 Cypress 的工程取舍';
const sourceRefs = [
  { type: 'summary', value: summaryId, required: false },
  { type: 'research', value: researchId, required: false },
];
const items = [
  { kind: 'issue', id: issueId, title: '专题议题测试来源', snippet: '议题摘要', sourceRefs: [sourceRefs[0]] },
  { kind: 'bookmark', id: bookmarkId, title: '收藏测试来源', snippet: '收藏摘要', sourceRefs: [sourceRefs[1]] },
];
const planBrief = { question, objective: 'decide', questionsToAnswer: ['先比较成本'], comparisonOptions: ['Playwright', 'Cypress'], decisionDimensions: ['成本与资源'], constraints: [], successCriteria: [], contextRefs: [], outputType: 'markdown', sourcePolicy: 'prefer_user_sources', scope: { timeRange: { preset: 'any' }, regions: [], technologyVersions: [], retrievalNotes: '' } };
const messages = [
  { id: 'message-1', role: 'assistant', content: '告诉我你的问题。', createdAt: '2026-01-01T00:00:00Z' },
  { id: 'message-2', role: 'user', content: question, createdAt: '2026-01-01T00:00:01Z' },
  { id: 'message-3', role: 'assistant', content: '主题已明确。', createdAt: '2026-01-01T00:00:02Z' },
];

async function mockWorkspace(page: Page) {
  let showSources = true;
  let submitted: Record<string, unknown> | undefined;
  await page.route('**/api/**', route => route.fulfill({ json: {} }));
  await page.route('**/api/auth/session', route => route.fulfill({ json: { user: { id: userId, role: 'member' }, expires: '2099-01-01' } }));
  await page.route('**/api/me/**', route => route.fulfill({ json: { items: [], count: 0, unreadCount: 0 } }));
  await page.route('**/api/ai-research/jobs*', route => route.fulfill({ json: { items: [], total: 0 } }));
  await page.route('**/api/ai-research/conversations*', route => route.fulfill({ json: { items: [] } }));
  await page.route(`**/api/ai-research/conversations/${conversationId}`, route => route.fulfill({ json: { id: conversationId, userId, title: question, jobId: null, status: 'active', messages, messageCount: 3, createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z' } }));
  await page.route('**/api/ai-research/context?*', route => route.fulfill({ json: { items: showSources ? items : [] } }));
  await page.route('**/api/ai-research/plan', route => route.fulfill({ json: { assistantMessage: '方案已准备', ready: true, missingFields: [], suggestedTopics: [], suggestedContext: [], brief: planBrief } }));
  await page.route(`**/api/ai-research/${jobId}`, route => route.fulfill({ json: { jobId, reportType: 'research_report', reportLength: 'deep', sourcePolicy: 'prefer_user_sources', sourceRefs, status: 'queued', currentStep: 'search' } }));
  await page.route('**/api/ai-research', route => { submitted = route.request().postDataJSON() as Record<string, unknown>; return route.fulfill({ status: 202, json: { jobId } }); });
  return { hideSources() { showSources = false; }, submitted: () => submitted };
}

test('selected issue and bookmark survive refresh even when search no longer returns them', async ({ page }) => {
  const mock = await mockWorkspace(page);
  await page.goto(`/ai-research?conversation=${conversationId}`);
  const focus = page.getByRole('textbox', { name: '重点回答' });
  await expect(focus).toHaveValue('先比较成本');
  const details = page.locator('summary').filter({ hasText: '历史资料建议（可选）' });
  await details.click();
  await page.getByRole('checkbox', { name: '使用资料：专题议题测试来源' }).check();
  await page.getByRole('checkbox', { name: '使用资料：收藏测试来源' }).check();
  await expect.poll(async () => page.evaluate(([u, c]) => {
    const raw = localStorage.getItem(`ai-research-draft:v1:${u}:${c}`);
    return raw ? JSON.parse(raw).brief?.selectedContextItems?.length : 0;
  }, [userId, conversationId])).toBe(2);
  mock.hideSources();
  await page.reload();
  await expect(focus).toHaveValue('先比较成本');
  const selected = page.getByRole('region', { name: '已选历史资料' });
  await expect(selected).toContainText('专题议题测试来源');
  await expect(selected).toContainText('收藏测试来源');
  await focus.fill('验证手动修改后的成本和风险');
  await page.getByRole('button', { name: '开始调研', exact: true }).click();
  await expect.poll(mock.submitted).toBeTruthy();
  expect(mock.submitted()?.sourceRefs).toEqual(sourceRefs);
});

test('legacy draft keeps references and blocks partial deselection until old selection is cleared', async ({ page }) => {
  const mock = await mockWorkspace(page);
  const draft = { reportType: 'research_report', reportLength: 'deep', sourcePolicy: 'prefer_user_sources', sourceUrls: [], sourceDraft: '', input: '', seed: null,
    brief: { objective: 'decide', suggestedContextIds: [issueId, bookmarkId], assistantMessage: 'Ready', scopeValid: true, brief: { ...planBrief, contextRefs: sourceRefs } } };
  await page.addInitScript(({ user, conversation, saved }) => { const key = `ai-research-draft:v1:${user}:${conversation}`; if (!localStorage.getItem(key)) localStorage.setItem(key, JSON.stringify(saved)); }, { user: userId, conversation: conversationId, saved: draft });
  mock.hideSources();
  await page.goto(`/ai-research?conversation=${conversationId}`);
  const focus = page.getByRole('textbox', { name: '重点回答' });
  await expect(focus).toHaveValue('先比较成本');
  await focus.fill('更新旧草稿重点');
  await expect.poll(async () => page.evaluate(([u, c]) => {
    const raw = localStorage.getItem(`ai-research-draft:v1:${u}:${c}`);
    return raw ? JSON.parse(raw).brief?.brief?.contextRefs : null;
  }, [userId, conversationId])).toEqual(sourceRefs);
  const details = page.locator('summary').filter({ hasText: '历史资料建议（可选）' });
  await details.click();
  await page.getByRole('checkbox', { name: `使用资料：旧草稿已选资料 (${issueId})` }).click();
  await expect(page.getByRole('checkbox', { name: `使用资料：旧草稿已选资料 (${issueId})` })).toHaveCount(0);
  await expect(page.getByRole('alert').filter({ hasText: '旧草稿没有保存资料与来源的对应关系' })).toBeVisible();
  const start = page.getByRole('button', { name: '开始调研', exact: true });
  await expect(start).toBeDisabled();
  expect(mock.submitted()).toBeUndefined();
  await expect.poll(async () => page.evaluate(([u, c]) => {
    const raw = localStorage.getItem(`ai-research-draft:v1:${u}:${c}`);
    return raw ? JSON.parse(raw).brief?.contextSelectionIncomplete : false;
  }, [userId, conversationId])).toBe(true);
  await page.reload();
  await expect(start).toBeDisabled();
  await expect(page.getByRole('alert').filter({ hasText: '旧草稿没有保存资料与来源的对应关系' })).toBeVisible();
  await details.click();
  await page.getByRole('checkbox', { name: `使用资料：旧草稿已选资料 (${bookmarkId})` }).click();
  await expect(page.getByRole('checkbox', { name: `使用资料：旧草稿已选资料 (${bookmarkId})` })).toHaveCount(0);
  await expect(start).toBeEnabled();
  await start.click();
  await expect.poll(mock.submitted).toBeTruthy();
  expect(mock.submitted()?.sourceRefs).toEqual([]);
});
