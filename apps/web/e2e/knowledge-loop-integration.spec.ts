import { randomUUID } from 'node:crypto';
import { test, expect } from '@playwright/test';
import { isolatedMuiOrigin, loginMuiFixture } from './mui-local-fixtures';

test('an explicitly saved judgment returns to its topic and paraphrased opening, without crossing accounts', async ({ page, browser }, testInfo) => {
  const origin = isolatedMuiOrigin();
  await loginMuiFixture(page.request, 'member');
  const response = await page.request.get(`${origin}/api/radar?quality=deep_read&date=all&page=1&per_page=20`);
  expect(response.ok()).toBe(true);
  const { items } = await response.json() as { items: Array<{ id: string; url: string; title: string; topics: Array<{ id: string; slug: string }> }> };
  const radar = items.find(item => item.topics.length > 0)!;
  expect(radar).toBeTruthy();
  const note = `GraphRAG 检索成本：先验证索引维护成本，再决定是否采用。${randomUUID().slice(0, 8)}`;
  const payload = { url: radar.url, radarSummaryId: radar.id, title: 'GraphRAG 检索的个人判断', quote: '来源摘要用于核对，不代表我的结论。', note, idempotencyKey: randomUUID() };
  const saved = await page.request.post(`${origin}/api/reading/save`, { data: payload });
  expect(saved.status()).toBe(201);
  const { draft } = await saved.json();
  expect(draft.status).toBe('draft');
  const retry = await page.request.post(`${origin}/api/reading/save`, { data: payload });
  expect(retry.status()).toBe(200);
  expect((await retry.json()).draft.id).toBe(draft.id);

  const related = await page.request.get(`${origin}/api/knowledge/related?radarSummaryId=${radar.id}`);
  expect((await related.json()).items).toEqual(expect.arrayContaining([expect.objectContaining({ id: draft.id, private: true, conclusion: expect.stringContaining(note) })]));
  const reread = await page.request.get(`${origin}/api/reading/save?url=${encodeURIComponent(radar.url)}`);
  expect((await reread.json()).items).toEqual(expect.arrayContaining([expect.objectContaining({ id: draft.id, radarSummaryId: radar.id })]));
  const context = await page.request.get(`${origin}/api/ai-research/context?q=${encodeURIComponent('如何控制 GraphRAG 的索引和检索成本？')}`);
  expect((await context.json()).items).toEqual(expect.arrayContaining([expect.objectContaining({ id: draft.id, private: true, confirmedKnowledge: true })]));
  const plan = await page.request.post(`${origin}/api/ai-research/plan`, { data: { question: '是否采用 GraphRAG 来优化检索成本？', primaryTopicId: radar.topics[0]!.id } });
  expect(plan.ok()).toBe(true);
  const planned = await plan.json();
  expect(planned.suggestedContext).toEqual(expect.arrayContaining([expect.objectContaining({ id: draft.id })]));
  expect(planned.brief.contextRefs ?? []).toEqual([]);

  await page.goto(`/topics/${radar.topics[0]!.slug}?tab=research`);
  await page.getByRole('tab', { name: /相关研究/ }).click();
  await expect(page.getByRole('tabpanel').filter({ visible: true }).getByRole('link', { name: payload.title, exact: true }).first()).toBeVisible();
  await page.goto(`/radar/${radar.id}`);
  await expect(page.getByRole('region', { name: '你之前的判断' }).getByText(note, { exact: false })).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath('private-judgment-returned.png'), fullPage: true });

  const other = await browser.newContext();
  try {
    await loginMuiFixture(other.request, 'other');
    const others = await other.request.get(`${origin}/api/knowledge/related?radarSummaryId=${radar.id}`);
    expect((await others.json()).items.some((item: { id: string }) => item.id === draft.id)).toBe(false);
    const denied = await other.request.get(`${origin}/api/researches/${draft.id}`);
    expect(denied.status()).toBe(404);
    const otherPage = await other.newPage();
    await otherPage.goto(`${origin}/topics/${radar.topics[0]!.slug}`);
    await expect(otherPage.getByRole('link', { name: payload.title, exact: true })).toHaveCount(0);
  } finally {
    await other.close();
  }
  const anonymous = await browser.newContext();
  try {
    const result = await anonymous.request.get(`${origin}/api/knowledge/related?radarSummaryId=${radar.id}`);
    expect(result.status()).toBe(401);
    const anonymousPage = await anonymous.newPage();
    await anonymousPage.goto(`${origin}/topics/${radar.topics[0]!.slug}`);
    await expect(anonymousPage.getByRole('link', { name: payload.title, exact: true })).toHaveCount(0);
  } finally {
    await anonymous.close();
  }
  // Keep this synthetic draft as acceptance evidence; never delete data automatically.
});
