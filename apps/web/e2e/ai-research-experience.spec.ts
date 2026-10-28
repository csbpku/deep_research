import { test, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';

const conversationId = 'f0500000-0000-4000-8000-000000000001';
const question = '比较 Playwright 和 Cypress 的工程取舍';

async function mockWorkspace(page: import('@playwright/test').Page) {
  let messages: Array<Record<string, unknown>> = [];
  const conversation = () => ({ id: conversationId, title: question, jobId: null, status: 'active', messages, messageCount: messages.length, createdAt: '2026-10-28T00:00:00Z', updatedAt: '2026-10-28T00:00:00Z' });
  await page.route('**/api/auth/session', route => route.fulfill({ json: { user: { id: 'fixture-user', email: 'fixture@e2e.local', name: '体验测试', role: 'member' }, expires: '2099-01-01' } }));
  await page.route('**/api/ai-research/jobs*', route => route.fulfill({ json: { items: [], total: 0 } }));
  await page.route('**/api/ai-research/conversations*', route => {
    if (route.request().method() === 'POST') {
      messages = route.request().postDataJSON().messages.map((m: Record<string, unknown>, i: number) => ({ ...m, id: `message-${i}`, createdAt: new Date(i).toISOString() }));
      return route.fulfill({ status: 201, json: conversation() });
    }
    return route.fulfill({ json: { items: [] } });
  });
  await page.route(`**/api/ai-research/conversations/${conversationId}`, route => route.fulfill({ json: conversation() }));
  await page.route('**/api/ai-research/context?*', route => route.fulfill({ json: { items: [] } }));
  await page.route('**/api/ai-research/plan', route => route.fulfill({ json: {
    assistantMessage: '方案已准备好', ready: true, missingFields: [], suggestedTopics: [], suggestedContext: [],
    brief: { question, objective: 'decide', questionsToAnswer: ['适用边界与工程代价'], comparisonOptions: ['Playwright', 'Cypress'], decisionDimensions: ['效果与适用范围', '安全与风险'], constraints: [], successCriteria: [], contextRefs: [], outputType: 'markdown', sourcePolicy: 'prefer_user_sources', scope: { timeRange: { preset: 'any' }, regions: [], technologyVersions: [], retrievalNotes: '' } },
  } }));
  await page.route('**/api/me/**', route => route.fulfill({ json: { items: [], count: 0, unreadCount: 0 } }));
}

for (const mode of ['light', 'dark'] as const) {
  test(`${mode}: research choices have groups, one selection and a clear summary`, async ({ page }, testInfo) => {
    await page.addInitScript(theme => localStorage.setItem('dr-theme', theme), mode);
    await mockWorkspace(page);
    await page.goto('/ai-research');
    await page.getByRole('textbox', { name: 'AI 调研对话输入' }).fill(question);
    await page.getByRole('textbox', { name: 'AI 调研对话输入' }).press('Control+Enter');
    await expect(page.getByRole('textbox', { name: '重点回答' })).toHaveValue('适用边界与工程代价');
    const output = page.getByRole('radiogroup', { name: '交付什么', exact: true });
    await expect(output.getByRole('radio')).toHaveCount(4);
    await expect(output.getByRole('radio', { name: /研究稿/ })).toBeChecked();
    await output.getByRole('radio', { name: /网页简报/ }).check();
    await expect(page.getByRole('region', { name: '启动配置摘要', exact: true })).toContainText('网页简报');
    const depth = page.getByRole('radiogroup', { name: '投入多少', exact: true });
    await expect(depth.getByRole('radio')).toHaveCount(2);
    await depth.getByRole('radio', { name: /单轮研究/ }).check();
    await expect(page.getByRole('region', { name: '启动配置摘要', exact: true })).toContainText('单轮研究');
    await expect(page.getByRole('radiogroup', { name: '参考什么', exact: true })).toBeVisible();
    const radio = output.getByRole('radio', { name: /网页简报/ });
    await radio.focus();
    await radio.press('ArrowLeft');
    await expect(output.getByRole('radio', { name: /Slides 提纲/ })).toBeChecked();
    const sizes = await output.getByRole('radio').evaluateAll(elements => elements.map(e => e.closest('label')!.getBoundingClientRect().height));
    expect(Math.max(...sizes) - Math.min(...sizes)).toBeLessThan(2);
    const issues = await new AxeBuilder({ page }).include('[aria-label="AI 调研对话"]').analyze();
    expect(issues.violations).toEqual([]);
    await page.screenshot({ path: testInfo.outputPath(`research-plan-${mode}.png`), fullPage: true });
  });
}

for (const width of [320, 390, 768, 1024, 1440]) {
  test(`all initial messages and examples remain inside the card at ${width}px`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width, height: 900 });
    await mockWorkspace(page);
    await page.goto('/ai-research');
    const card = page.getByRole('region', { name: 'AI 调研对话', exact: true });
    await expect(page.getByRole('button', { name: '哪些 HTML 转 Markdown 工具最不容易丢失结构？', exact: true })).toBeVisible();
    const bounds = await card.evaluate(el => ({ card: el.clientWidth, content: el.scrollWidth, page: document.documentElement.scrollWidth, viewport: innerWidth }));
    expect(bounds.content).toBeLessThanOrEqual(bounds.card + 1);
    expect(bounds.page).toBeLessThanOrEqual(bounds.viewport);
    await page.screenshot({ path: testInfo.outputPath(`research-start-${width}.png`), fullPage: true });
  });
}
