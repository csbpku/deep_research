import { randomUUID } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import type { Page, Response } from '@playwright/test';
import { test, expect, loginWithCredentials, waitForHydration } from './fixtures';

const prisma = new PrismaClient();

async function deleteSyntheticDraft(page: Page, id: string): Promise<void> {
  const response = await page.request.delete(`/api/researches/${id}`);
  expect([200, 404]).toContain(response.status());
}

test.describe('Research follow-up and personal knowledge', () => {
  test('a followed topic remains available from the followed filter', async ({ page }) => {
    await loginWithCredentials(page.context().request, {
      email: 'member@e2e.local',
      role: 'member',
    });
    await page.request.delete('/api/topics/ai-agents/follow');
    try {
      await page.goto('/topics/ai-agents');
      await page.getByRole('button', { name: '关注' }).click();
      await expect(page.getByRole('button', { name: '取消关注' })).toBeVisible();

      await page.goto('/topics?filter=followed');
      await expect(page.getByRole('link', { name: /AI Agents/ }).first()).toBeVisible();
      await page.goto('/topics/ai-agents?tab=issues');
      await expect(page.getByRole('heading', { name: '活跃热点议题' })).toBeVisible();
    } finally {
      await page.request.delete('/api/topics/ai-agents/follow').catch(() => undefined);
    }
  });

  test('Reader saves searchable private knowledge, refreshes its index intent, then leaves a delete tombstone', async ({ page, request, browser }) => {
    await loginWithCredentials(page.context().request, {
      email: 'member@e2e.local',
      role: 'member',
    });

    const oldMarker = `privatee2e${randomUUID().replaceAll('-', '')}`;
    const newMarker = `updatede2e${randomUUID().replaceAll('-', '')}`;
    const idempotencyKey = randomUUID();
    const quote = 'A short synthetic excerpt that must not enter the personal vector index.';
    const note = `Confirmed engineering judgment ${oldMarker}: retry with bounded backoff.`;
    const aiAnswer = 'Keep the retry boundary idempotent and preserve the source link.';
    const savePayload = {
      url: 'https://example.com/synthetic-reader-e2e',
      title: `Reader judgment ${randomUUID().slice(0, 8)}`,
      quote,
      note,
      aiAnswer,
      tags: ['e2e'],
      idempotencyKey,
    };
    let researchId: string | null = null;
    let deleted = false;

    try {
      const saved = await page.request.post('/api/reading/save', { data: savePayload });
      expect(saved.status()).toBe(201);
      const savedBody = await saved.json() as { draft: { id: string; status: string } };
      researchId = savedBody.draft.id;
      expect(savedBody.draft.status).toBe('draft');

      const repeated = await page.request.post('/api/reading/save', { data: savePayload });
      expect(repeated.status()).toBe(200);
      expect(await repeated.json()).toMatchObject({ draft: { id: researchId }, deduplicated: true });

      const ownerSearch = await page.request.get('/api/search', { params: { q: oldMarker, type: 'knowledge' } });
      expect(ownerSearch.status()).toBe(200);
      const ownerResults = await ownerSearch.json() as { items: Array<{ refId: string; isPrivate: boolean }> };
      expect(ownerResults.items).toEqual(expect.arrayContaining([
        expect.objectContaining({ refId: researchId, isPrivate: true }),
      ]));

      await page.goto(`/search?q=${encodeURIComponent(oldMarker)}&type=knowledge`);
      await expect(page.getByRole('link', { name: savePayload.title })).toBeVisible();
      await expect(page.getByText('本人草稿')).toBeVisible();

      const publicSearch = await request.get('/api/search', { params: { q: 'E2E Seed Research' } });
      expect(publicSearch.status()).toBe(200);
      const publicResults = await publicSearch.json() as { items: Array<{ type: string; title: string; isPrivate: boolean }> };
      expect(publicResults.items).toEqual(expect.arrayContaining([
        expect.objectContaining({ type: 'long_research', title: 'E2E Seed Research', isPrivate: false }),
      ]));

      await page.goto('/search?q=E2E%20Seed%20Research');
      await expect(page.getByRole('link', { name: 'E2E Seed Research' })).toBeVisible();

      const anonymousSearch = await request.get('/api/search', { params: { q: oldMarker, type: 'knowledge' } });
      expect(anonymousSearch.status()).toBe(200);
      expect((await anonymousSearch.json() as { items: unknown[] }).items).toHaveLength(0);

      const otherContext = await browser.newContext({ baseURL: process.env.E2E_BASE_URL ?? 'http://127.0.0.1:3000' });
      try {
        await loginWithCredentials(otherContext.request, {
          email: 'e2e-admin@e2e.local',
          role: 'admin',
        });
        const otherSearch = await otherContext.request.get('/api/search', { params: { q: oldMarker, type: 'knowledge' } });
        expect(otherSearch.status()).toBe(200);
        expect((await otherSearch.json() as { items: unknown[] }).items).toHaveLength(0);
      } finally {
        await otherContext.close();
      }

      const contextResponse = await page.request.get('/api/ai-research/context', { params: { q: oldMarker } });
      expect(contextResponse.status()).toBe(200);
      const contextBody = await contextResponse.json() as {
        items: Array<{ id: string; kind: string; private?: boolean; sourceRefs?: Array<{ type: string; value: string; required: boolean }> }>;
      };
      expect(contextBody.items).toEqual(expect.arrayContaining([
        expect.objectContaining({
          id: researchId,
          kind: 'knowledge',
          private: true,
          sourceRefs: [{ type: 'research', value: researchId, required: false }],
        }),
      ]));

      const savedResearch = await prisma.research.findUnique({
        where: { id: researchId },
        select: { knowledgeIndexText: true },
      });
      expect(savedResearch?.knowledgeIndexText).toContain(note);
      expect(savedResearch?.knowledgeIndexText).toContain(aiAnswer);
      expect(savedResearch?.knowledgeIndexText).not.toContain(quote);

      const initialTask = await prisma.personalKnowledgeIndexTask.findUnique({
        where: { researchId },
        select: { operation: true, status: true, generation: true },
      });
      expect(initialTask).toMatchObject({ operation: 'upsert', status: 'queued', generation: 1 });

      const revisedNote = `Revised judgment ${newMarker}: retry only after checking the idempotency key.`;
      const revisedBody = `> ${quote}\n\n## 我的笔记\n\n${revisedNote}\n\n## AI 解读\n\n${aiAnswer}`;
      const edited = await page.request.put(`/api/researches/${researchId}`, { data: { body: revisedBody } });
      expect(edited.status()).toBe(200);

      const editedResearch = await prisma.research.findUnique({
        where: { id: researchId },
        select: { knowledgeIndexText: true },
      });
      expect(editedResearch?.knowledgeIndexText).toContain(revisedNote);
      expect(editedResearch?.knowledgeIndexText).not.toContain(oldMarker);
      expect(editedResearch?.knowledgeIndexText).not.toContain(quote);

      const updatedTask = await prisma.personalKnowledgeIndexTask.findUnique({
        where: { researchId },
        select: { operation: true, status: true, generation: true },
      });
      expect(updatedTask).toMatchObject({ operation: 'upsert', status: 'queued', generation: 2 });

      const deletion = await page.request.delete(`/api/researches/${researchId}`);
      expect(deletion.status()).toBe(200);
      deleted = true;
      expect((await page.request.get(`/api/researches/${researchId}`)).status()).toBe(404);
      const postDeleteSearch = await page.request.get('/api/search', { params: { q: newMarker, type: 'knowledge' } });
      expect(postDeleteSearch.status()).toBe(200);
      expect((await postDeleteSearch.json() as { items: unknown[] }).items).toHaveLength(0);
      const deleteTask = await prisma.personalKnowledgeIndexTask.findUnique({
        where: { researchId },
        select: { operation: true, status: true, generation: true, documentPath: true },
      });
      expect(deleteTask).toMatchObject({ operation: 'delete', status: 'queued', generation: 3 });
    } finally {
      if (researchId && !deleted) {
        await deleteSyntheticDraft(page, researchId);
      }
    }
  });

  test('AI research only sends a suggested private source after it is selected', async ({ page }) => {
    await loginWithCredentials(page.context().request, {
      email: 'member@e2e.local',
      role: 'member',
    });

    const marker = `reusee2e${randomUUID().replaceAll('-', '')}`;
    const sourceTitle = `个人知识复用判断 ${randomUUID().slice(0, 8)}`;
    let researchId: string | null = null;
    let conversationId: string | null = null;
    let submitted: Record<string, unknown> | null = null;
    try {
      const saved = await page.request.post('/api/reading/save', {
        data: {
          url: 'https://example.com/synthetic-reader-context-e2e',
          title: sourceTitle,
          quote: 'A synthetic excerpt used to validate selected context reuse.',
          note: `研究个人知识复用 ${marker}：保留经过确认的判断及其适用边界。`,
          tags: ['e2e'],
          idempotencyKey: randomUUID(),
        },
      });
      expect(saved.status()).toBe(201);
      const savedBody = await saved.json() as { draft: { id: string } };
      const savedResearchId = savedBody.draft.id;
      researchId = savedResearchId;

      await page.route('**/api/ai-research/plan', (route) => route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          assistantMessage: '研究方案已准备好。',
          brief: {
            objective: 'investigate',
            question: '研究个人知识复用',
            constraints: [],
            questionsToAnswer: ['资料如何复用'],
            comparisonOptions: [],
            successCriteria: [],
            sourcePolicy: 'prefer_user_sources',
            contextRefs: [],
            primaryTopicId: null,
            outputType: 'markdown',
          },
          plan: { summary: '检查已有判断如何进入新研究。', steps: [], estimatedMinutes: 5 },
          ready: true,
          missingFields: [],
          suggestedTopics: [],
          suggestedContext: [],
        }),
      }));
    await page.route('**/api/ai-research', async (route) => {
        if (route.request().method() !== 'POST') return route.continue();
        submitted = route.request().postDataJSON() as Record<string, unknown>;
        return route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({ jobId: randomUUID() }),
        });
      });

      await page.goto('/ai-research');
      const input = page.getByRole('textbox', { name: 'AI 调研对话输入' });
      const createdConversationResponse = page.waitForResponse((response) => {
        const request = response.request();
        return new URL(response.url()).pathname === '/api/ai-research/conversations' &&
          request.method() === 'POST';
      });
      await input.fill(`研究个人知识复用 ${marker}`);
      await page.getByRole('button', { name: '发送消息（AI 调研）' }).click();
      const conversationResponse = await createdConversationResponse;
      conversationId = (await conversationResponse.json() as { id: string }).id;
      expect(conversationResponse.status()).toBe(201);
      await input.fill('重点检查来源权限和复用边界');
      await page.getByRole('button', { name: '发送消息（AI 调研）' }).click();

      await expect(page.getByText('研究方案', { exact: true })).toBeVisible();
      await waitForHydration(page);
      const contextDetails = page.locator('details').filter({ hasText: '已有资料（可选）' });
      await expect(contextDetails).toHaveCount(1);
      const contextSummary = contextDetails.locator('summary');
      let contextResponse: Response | null = null;
      page.on('response', (response) => {
        if (new URL(response.url()).pathname === '/api/ai-research/context') {
          contextResponse = response;
        }
      });
      await contextSummary.click();
      await expect(contextDetails).toHaveAttribute('open', '');
      await expect(contextSummary).toHaveAttribute('aria-expanded', 'true');
      await expect(page.getByText('正在搜索可用个人资料…')).toBeVisible();
      await expect.poll(() => contextResponse).not.toBeNull();
      expect(contextResponse?.status()).toBe(200);
      const retrieved = await contextResponse?.json() as { items: Array<{ id: string }> };
      expect(retrieved.items).toEqual(expect.arrayContaining([
        expect.objectContaining({ id: savedResearchId }),
      ]));
      const suggestedSource = page.getByRole('button', { name: new RegExp(sourceTitle) });
      await expect(suggestedSource).toBeVisible();
      await expect(suggestedSource).toContainText('仅本人');
      await expect(suggestedSource).toHaveAttribute('aria-pressed', 'false');
      await suggestedSource.click();
      await expect(suggestedSource).toHaveAttribute('aria-pressed', 'true');
      await page.getByRole('button', { name: '开始调研' }).click();

      await expect.poll(() => submitted).not.toBeNull();
      expect(submitted?.sourceRefs).toEqual([
        { type: 'research', value: savedResearchId, required: false },
      ]);
      expect((submitted?.brief as { contextRefs?: unknown[] }).contextRefs).toEqual([
        { type: 'research', value: savedResearchId, required: false },
      ]);
    } finally {
      try {
        if (researchId) {
          await deleteSyntheticDraft(page, researchId);
        }
      } finally {
        if (conversationId) {
          await prisma.aiResearchConversation.deleteMany({ where: { id: conversationId } });
        }
      }
    }
  });
});
