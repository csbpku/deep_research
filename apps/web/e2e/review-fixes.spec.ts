import { randomUUID } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import { test, expect } from './fixtures';

const prisma = new PrismaClient();
test.afterAll(async () => { await prisma.$disconnect(); });

test('the authenticated preflight BFF reaches the engine endpoint', async ({ page }) => {
  const response = await page.request.get('/api/ai-research/preflight');
  expect(response.status()).toBe(200);
  const body = await response.json();
  expect(body.ok).toBe(true);
  expect(body.checks).toEqual(expect.arrayContaining([expect.objectContaining({ name: 'adapter', ok: true })]));
  expect(body.checks.some((check: { name: string }) => check.name === 'ai_engine')).toBe(false);
});

test('cached radar previews keep feedback attached to the selected article', async ({ page }, testInfo) => {
  const a = '10000000-0000-4000-8000-000000000061';
  const b = '10000000-0000-4000-8000-000000000062';
  const counts = { favorite: 0, useful: 0, inaccurate: 0, used: 0, suggest_research: 0, read: 0, later: 0, pilot: 0 };
  const candidate = {
    title: 'Cached article', excerpt: 'A synthetic radar candidate.', url: 'https://example.com/review-fixture',
    sourceType: 'rss', sourceName: 'Review fixture', originalKind: 'article', tags: [], status: 'published',
    interpretation: 'A concise reason to read this article.', tier: 'deep_read', publishedAt: null,
    crawledAt: '2026-11-20T00:00:00Z', distilledScore: null, commentCount: 0, topics: [], issues: [],
  };
  const articles = [
    { ...candidate, id: a, title: 'Cached article A', feedbackCounts: { ...counts, read: 7 }, myFeedbacks: ['read'] },
    { ...candidate, id: b, title: 'Cached article B', feedbackCounts: counts, myFeedbacks: [] },
  ];
  await page.route('**/api/radar?*', route => route.fulfill({ json: { items: articles, page: 1, perPage: 20, total: 2, totalPages: 1 } }));
  for (const article of articles) {
    await page.route(`**/api/radar/${article.id}?*`, route => route.fulfill({ json: { ...article, isAuthenticated: true } }));
  }
  const submitted: Array<{ method: string; body: unknown }> = [];
  await page.route('**/api/radar-feedback**', async route => {
    const request = route.request();
    submitted.push({ method: request.method(), body: request.postDataJSON() });
    await route.fulfill({ json: { feedbackCounts: { ...counts, read: 1 }, created: true } });
  });
  await page.goto('/radar?view=ranked');
  const preview = page.locator('[data-radar-preview-body]').filter({ visible: true });
  async function select(id: string, title: string) {
    await page.locator(`[data-radar-preview-trigger="${id}"]`).click();
    await expect(page).toHaveURL(new RegExp(`open=${id}`));
    await expect(preview.getByText(title, { exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: '关闭预览', exact: true })).toBeVisible();
  }
  await select(a, 'Cached article A');
  await expect(preview.getByRole('button', { name: '已读（7）', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await select(b, 'Cached article B');
  await expect(preview.getByRole('button', { name: '已读（0）', exact: true })).toHaveAttribute('aria-pressed', 'false');
  // Both details are now in the query cache: switching no longer passes
  // through the unauthenticated list placeholder that could mask the bug.
  await select(a, 'Cached article A');
  await expect(preview.getByRole('button', { name: '已读（7）', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await select(b, 'Cached article B');
  await preview.getByRole('button', { name: '已读（0）', exact: true }).click();
  await expect(preview.getByRole('button', { name: '已读（1）', exact: true })).toHaveAttribute('aria-pressed', 'true');
  expect(submitted).toEqual([{ method: 'POST', body: { summaryId: b, feedbackType: 'read' } }]);
  await page.screenshot({ path: testInfo.outputPath('radar-feedback.png') });
});

test('the owner can revise a due knowledge judgement through the real form and API', async ({ page }, testInfo) => {
  const owner = await prisma.user.findUniqueOrThrow({ where: { email: 'e2e-admin@e2e.local' } });
  const row = await prisma.research.create({ data: {
    type: 'knowledge', status: 'published', title: `Judgement UI ${randomUUID()}`, body: 'Synthetic evidence.',
    authorId: owner.id, judgement: 'The original judgement needs revision.', judgementConfidence: 'low',
    judgementScope: 'Original scope.', judgementReviewAt: new Date('2020-01-01'), publishedAt: new Date(),
  } });
  await page.goto(`/researches/${row.id}`);
  await page.getByRole('button', { name: '需要修订', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '修订知识卡判断' });
  await expect(dialog.getByRole('textbox', { name: /^判断/ })).toHaveValue(row.judgement!);
  const claim = 'The revised judgement applies to bounded workloads.';
  await dialog.getByRole('textbox', { name: /^判断/ }).fill(claim);
  await dialog.getByRole('textbox', { name: /^适用边界/ }).fill('Only for stable production workloads.');
  await dialog.getByRole('combobox', { name: '置信度' }).click();
  await page.getByRole('option', { name: '高', exact: true }).click();
  const saved = page.waitForResponse(response => response.url().endsWith(`/researches/${row.id}/judgement`) && response.request().method() === 'POST');
  await dialog.getByRole('button', { name: '保存修订并设置复查' }).click();
  expect((await saved).status()).toBe(200);
  await expect(dialog).toBeHidden();
  await expect(page.getByText(claim, { exact: true })).toBeVisible();
  const persisted = await prisma.research.findUniqueOrThrow({ where: { id: row.id } });
  expect(persisted).toMatchObject({ status: 'published', judgement: claim, judgementConfidence: 'high' });
  expect(persisted.knowledgeIndexText).toContain(claim);
  expect(await prisma.researchAudit.count({ where: { researchId: row.id, action: 'edit' } })).toBe(1);
  const dueRequest = page.waitForRequest(request => {
    const url = new URL(request.url());
    return url.pathname === '/api/researches' && url.searchParams.get('judgementDue') === 'true';
  });
  await page.goto('/review');
  expect(new URL((await dueRequest).url()).searchParams.get('scope')).toBe('mine');
  await expect(page.getByRole('link', { name: row.title, exact: true })).toHaveCount(0);
  await page.screenshot({ path: testInfo.outputPath('personal-review-queue.png') });
});

test('the editor submits the acknowledged publication version', async ({ page }) => {
  const owner = await prisma.user.findUniqueOrThrow({ where: { email: 'e2e-admin@e2e.local' } });
  const row = await prisma.research.create({ data: {
    type: 'research', status: 'draft', title: `Disclosure UI ${randomUUID()}`, body: 'Synthetic report with pending review.',
    background: 'Research background.', conclusion: 'Conditional conclusion.', risks: 'Pending verification.',
    authorId: owner.id, creationMethod: 'ai_research', originContentSha256: '0'.repeat(64), aiAssisted: true,
  } });
  await page.goto(`/researches/${row.id}/edit`);
  await page.getByRole('button', { name: '发布调研', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '确认发布调研？' });
  await expect(dialog.getByRole('button', { name: '确认发布', exact: true })).toBeDisabled();
  await dialog.getByRole('checkbox', { name: '我已知晓上述不确定性，并同意带披露发布。' }).check();
  const published = page.waitForResponse(response => response.url().endsWith(`/researches/${row.id}/publish`));
  await dialog.getByRole('button', { name: '确认发布', exact: true }).click();
  const response = await published;
  expect(response.request().postDataJSON()).toMatchObject({ acknowledgeDisclosure: true, publicationVersion: expect.stringMatching(/^[a-f0-9]{64}$/) });
  expect(response.status()).toBe(200);
  await expect(page).toHaveURL(new RegExp(`/researches/${row.id}$`));
  expect((await prisma.research.findUniqueOrThrow({ where: { id: row.id } })).publishedReviewAcknowledgedAt).not.toBeNull();
});
