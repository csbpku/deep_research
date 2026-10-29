import { test, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';

const conversationId = 'f0500000-0000-4000-8000-000000000001';
const question = '比较 Playwright 和 Cypress 的工程取舍';

async function mockWorkspace(page: import('@playwright/test').Page) {
  let messages: Array<Record<string, unknown>> = [];
  let jobId: string | null = null;
  const conversation = () => ({ id: conversationId, userId: 'fixture-user', title: question, jobId, status: 'active', messages, messageCount: messages.length, createdAt: '2026-10-28T00:00:00Z', updatedAt: '2026-10-28T00:00:00Z' });
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
  await page.route('**/api/ai-research/context?*', route => route.fulfill({ json: { items: [{ kind: 'knowledge', id: 'f0500000-0000-4000-8000-000000000099', title: 'Python任务实践笔记', snippet: '可核查的任务取消观察。', private: true, confirmedKnowledge: true, sourceRefs: [{ type: 'research', value: 'f0500000-0000-4000-8000-000000000099', required: false }] }] } }));
  await page.route('**/api/ai-research/plan', route => route.fulfill({ json: {
    assistantMessage: '方案已准备好', ready: true, missingFields: [], suggestedTopics: [], suggestedContext: [],
    brief: { question, objective: 'decide', questionsToAnswer: ['适用边界与工程代价'], comparisonOptions: ['Playwright', 'Cypress'], decisionDimensions: ['效果与适用范围', '安全与风险'], constraints: [], successCriteria: [], contextRefs: [], outputType: 'markdown', sourcePolicy: 'prefer_user_sources', scope: { timeRange: { preset: 'any' }, regions: [], technologyVersions: [], retrievalNotes: '' } },
  } }));
  await page.route('**/api/me/**', route => route.fulfill({ json: { items: [], count: 0, unreadCount: 0 } }));
  return { bindJob: (id: string) => { jobId = id; } };
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
    await expect(output.getByRole('radio', { name: /^研究稿/ })).toBeChecked();
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
    const suggestions = page.locator('summary').filter({ hasText: '历史资料建议（可选）' });
    await suggestions.click();
    await page.getByRole('checkbox', { name: '使用资料：Python任务实践笔记', exact: true }).check();
    await suggestions.click();
    await expect(page.getByRole('region', { name: '已选历史资料', exact: true })).toContainText('Python任务实践笔记');
    const issues = await new AxeBuilder({ page }).include('[aria-label="AI 调研对话"]').analyze();
    expect(issues.violations).toEqual([]);
    await output.scrollIntoViewIfNeeded();
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


test('edited output, effort, sources and focus survive refresh and late planning', async ({ page }) => {
  await mockWorkspace(page);
  await page.goto('/ai-research');
  await page.getByRole('textbox', { name: 'AI 调研对话输入' }).fill(question);
  await page.getByRole('textbox', { name: 'AI 调研对话输入' }).press('Control+Enter');
  const focus = page.getByRole('textbox', { name: '重点回答' });
  await expect(focus).toHaveValue('适用边界与工程代价');
  await page.getByRole('radio', { name: /^网页简报/ }).check();
  await page.getByRole('radio', { name: /^单轮研究/ }).check();
  await page.getByRole('radio', { name: /^仅使用已选资料/ }).check();
  await page.getByRole('textbox', { name: '添加网页资料（可选）', exact: true }).fill('https://docs.python.org/3/library/asyncio-task.html');
  await page.getByRole('button', { name: '添加网页资料', exact: true }).click();
  await focus.fill('保留我明确编辑的取消行为问题');
  await expect(page.getByRole('region', { name: '启动配置摘要' })).toContainText('1 条已选资料');
  await page.reload();
  await expect(page.getByRole('textbox', { name: '重点回答' })).toHaveValue('保留我明确编辑的取消行为问题');
  await expect(page.getByRole('radio', { name: /^网页简报/ })).toBeChecked();
  await expect(page.getByRole('radio', { name: /^单轮研究/ })).toBeChecked();
  await expect(page.getByRole('radio', { name: /^仅使用已选资料/ })).toBeChecked();
  await expect(page.getByRole('region', { name: '启动配置摘要' })).toContainText('1 条已选资料');
});

test('message save failure never offers a research-submit retry', async ({ page }) => {
  await mockWorkspace(page);
  let saves = 0;
  let submissions = 0;
  await page.route('**/api/ai-research/conversations/*/messages', route => {
    saves++;
    return route.fulfill({ status: 503, json: { code: 'INTERNAL' } });
  });
  await page.route('**/api/ai-research', route => { submissions++; return route.fulfill({ status: 500, json: {} }); });
  await page.goto('/ai-research');
  const composer = page.getByRole('textbox', { name: 'AI 调研对话输入' });
  await composer.fill(question);
  await composer.press('Control+Enter');
  await expect(page.getByRole('textbox', { name: '重点回答' })).toBeVisible();
  await composer.fill('补充官方证据要求');
  await composer.press('Control+Enter');
  await expect(page.getByRole('alert').filter({ hasText: '保存失败' })).toBeVisible();
  await expect(page.getByRole('button', { name: /重试/ })).toHaveCount(0);
  await expect(composer).toBeEnabled();
  await composer.fill('继续补充，但不启动研究');
  await composer.press('Control+Enter');
  await expect.poll(() => saves).toBeGreaterThan(1);
  expect(submissions).toBe(0);
});

test('uncertain submission prevents accidental duplicate jobs', async ({ page }) => {
  await mockWorkspace(page);
  let submissions = 0;
  await page.route('**/api/ai-research', route => { submissions++; return route.fulfill({ status: 503, json: { code: 'AI_ENGINE_UNAVAILABLE' } }); });
  await page.goto('/ai-research');
  await page.getByRole('textbox', { name: 'AI 调研对话输入' }).fill(question);
  await page.getByRole('textbox', { name: 'AI 调研对话输入' }).press('Control+Enter');
  await expect(page.getByRole('textbox', { name: '重点回答' })).toBeVisible();
  await page.getByRole('button', { name: '开始调研', exact: true }).click();
  await expect(page.getByRole('button', { name: '开始调研', exact: true })).toBeDisabled();
  await expect(page.getByRole('link', { name: /任务历史/ })).toBeVisible();
  expect(submissions).toBe(1);
});


for (const width of [320, 390, 768, 1024, 1440]) {
  test(`research plan remains readable and actionable at ${width}px`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width, height: 900 });
    await mockWorkspace(page);
    await page.goto('/ai-research');
    await page.getByRole('textbox', { name: 'AI 调研对话输入' }).fill(question);
    await page.getByRole('textbox', { name: 'AI 调研对话输入' }).press('Control+Enter');
    await expect(page.getByRole('textbox', { name: '重点回答' })).toBeVisible();
    await page.getByRole('radio', { name: /^仅使用已选资料/ }).check();
    await page.getByRole('textbox', { name: '添加网页资料（可选）', exact: true }).fill('https://docs.python.org/3/library/asyncio-task.html#asyncio.TaskGroup');
    await page.getByRole('button', { name: '添加网页资料', exact: true }).click();
    const card = page.getByRole('region', { name: 'AI 调研对话', exact: true });
    const bounds = await card.evaluate(el => ({ card: el.clientWidth, content: el.scrollWidth, page: document.documentElement.scrollWidth, viewport: innerWidth }));
    expect(bounds.content).toBeLessThanOrEqual(bounds.card + 1);
    expect(bounds.page).toBeLessThanOrEqual(bounds.viewport);
    for (const name of ['交付什么', '投入多少', '参考什么']) {
      const labels = page.getByRole('radiogroup', { name, exact: true }).locator('label');
      const geometry = await labels.evaluateAll(elements => elements.map(el => {
        const box = el.getBoundingClientRect();
        return { left: box.left, right: box.right, client: el.clientWidth, content: el.scrollWidth };
      }));
      for (const item of geometry) {
        expect(item.left).toBeGreaterThanOrEqual(0);
        expect(item.right).toBeLessThanOrEqual(width);
        expect(item.content).toBeLessThanOrEqual(item.client + 1);
      }
    }
    await expect(page.getByRole('button', { name: '开始调研', exact: true })).toBeEnabled();
    if (width === 390) await page.screenshot({ path: testInfo.outputPath('research-plan-390.png'), fullPage: true });
  });
}

test('keyboard reaches and edits every confirmation group before starting', async ({ page }) => {
  await mockWorkspace(page);
  await page.goto('/ai-research');
  const composer = page.getByRole('textbox', { name: 'AI 调研对话输入' });
  await composer.focus();
  await page.keyboard.insertText(question);
  await page.keyboard.press('Control+Enter');
  await expect(page.getByRole('textbox', { name: '重点回答' })).toBeVisible();
  const tabTo = async (target: import('@playwright/test').Locator) => {
    for (let i = 0; i < 45; i++) {
      if (await target.evaluate(el => el === document.activeElement)) break;
      await page.keyboard.press('Tab');
    }
    await expect(target).toBeFocused();
  };
  const objective = page.getByRole('combobox', { name: '研究方式' });
  await tabTo(objective);
  await page.keyboard.press('Space');
  await expect(page.getByRole('listbox')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('listbox')).toHaveCount(0);
  await expect(objective).toBeFocused();
  const focus = page.getByRole('textbox', { name: '重点回答' });
  await tabTo(focus);
  await page.keyboard.press('ControlOrMeta+A');
  await page.keyboard.insertText('仅核对异常传播与取消行为');
  await page.keyboard.press('Tab');
  await expect(page.getByRole('textbox', { name: '对比对象' })).toBeFocused();
  const output = page.getByRole('radio', { name: /^研究稿/ });
  await tabTo(output);
  await page.keyboard.press('ArrowRight');
  await expect(page.getByRole('radio', { name: /^Slides 提纲/ })).toBeChecked();
  await page.keyboard.press('ArrowRight');
  await expect(page.getByRole('radio', { name: /^网页简报/ })).toBeChecked();
  await tabTo(page.getByRole('radio', { name: /^多轮研究/ }));
  await page.keyboard.press('ArrowLeft');
  await expect(page.getByRole('radio', { name: /^单轮研究/ })).toBeChecked();
  await tabTo(page.getByRole('radio', { name: /^网页搜索/ }));
  await page.keyboard.press('ArrowDown');
  await expect(page.getByRole('radio', { name: /^仅使用已选资料/ })).toBeChecked();
  const url = page.getByRole('textbox', { name: '添加网页资料（可选）', exact: true });
  await page.keyboard.press('Tab');
  await expect(url).toBeFocused();
  await page.keyboard.insertText('https://docs.python.org/3/library/asyncio-task.html');
  await page.keyboard.press('Enter');
  await expect(page.getByRole('region', { name: '启动配置摘要' })).toContainText('1 条已选资料');
  const suggestions = page.locator('summary').filter({ hasText: '历史资料建议（可选）' });
  await tabTo(suggestions);
  await page.keyboard.press('Space');
  const source = page.getByRole('checkbox', { name: '使用资料：Python任务实践笔记', exact: true });
  await tabTo(source);
  await page.keyboard.press('Space');
  await expect(source).toBeChecked();
  await expect(page.getByRole('region', { name: '已选历史资料' })).toContainText('Python任务实践笔记');
  await tabTo(page.getByRole('button', { name: '开始调研', exact: true }));
  await expect(page.getByRole('button', { name: '开始调研', exact: true })).toBeEnabled();
  await expect(focus).toHaveValue('仅核对异常传播与取消行为');
});
