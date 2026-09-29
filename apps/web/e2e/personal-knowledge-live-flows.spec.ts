import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { PrismaClient } from '@prisma/client';
import type { Page, Response } from '@playwright/test';
import { expect, loginWithCredentials, test, waitForHydration } from './fixtures';

const prisma = new PrismaClient();
const AI_ENGINE_ROOT = resolve(process.cwd(), '../../packages/ai-engine');
const BASE_URL = process.env.E2E_BASE_URL ?? 'http://127.0.0.1:3000';

function runIndexTask(taskId: string, cleanupOwnerId?: string): void {
  if (!process.env.TEST_ANYTHINGLLM_API_KEY || !process.env.TEST_DATABASE_URL) {
    throw new Error('the guarded live E2E runner requires TEST_ANYTHINGLLM_API_KEY and TEST_DATABASE_URL');
  }
  const args = [
    'run', '--no-sync', 'python', '-m', 'tests.run_personal_knowledge_index_task', taskId,
  ];
  if (cleanupOwnerId) args.push('--cleanup-owner-id', cleanupOwnerId);
  try {
    execFileSync('uv', args, {
      cwd: AI_ENGINE_ROOT,
      env: process.env,
      encoding: 'utf8',
      stdio: 'pipe',
      timeout: 90_000,
    });
  } catch {
    throw new Error('the explicitly selected synthetic index task did not complete');
  }
}

async function getContext(page: Page, query: string): Promise<{
  items: Array<{ id: string; kind: string; private?: boolean; semanticMatch?: boolean }>;
}> {
  const response = await page.request.get('/api/ai-research/context', { params: { q: query } });
  expect(response.status()).toBe(200);
  return response.json();
}

async function getIndexTask(researchId: string) {
  const task = await prisma.personalKnowledgeIndexTask.findUnique({
    where: { researchId },
    select: {
      id: true,
      status: true,
      operation: true,
      generation: true,
      ownerId: true,
      workspaceSlug: true,
      documentPath: true,
    },
  });
  expect(task).not.toBeNull();
  return task!;
}

test.skip(
  process.env.E2E_PERSONAL_KNOWLEDGE_LIVE !== '1',
  'requires the guarded local AnythingLLM + AI Engine runner',
);

test('Reader knowledge is semantically reused through Web and AI Engine, then replaced and deleted', async ({ page, browser }) => {
  test.setTimeout(150_000);
  const email = `personal-index-${randomUUID().replaceAll('-', '')}@e2e.local`;
  const title = `E2E semantic judgment ${randomUUID().slice(0, 8)}`;
  const quote = 'A synthetic excerpt retained only as a source reference.';
  const initialNote = 'When a payment operation times out after it may have committed, retries must reuse the same operation token to prevent a second charge.';
  const initialQuery = 'Avoid billing a customer twice when the outcome of a remote operation is uncertain.';
  const revisedNote = 'After a bad database schema release, roll forward with a reviewed inverse migration instead of rewriting deployed history.';
  const revisedQuery = 'How should production recover from an incompatible schema deployment without changing recorded history?';
  const marker = randomUUID();
  let researchId: string | null = null;
  let ownerId: string | null = null;
  let conversationId: string | null = null;

  await loginWithCredentials(page.context().request, { email, role: 'member' });
  try {
    const owner = await prisma.user.findUnique({ where: { email }, select: { id: true } });
    expect(owner).not.toBeNull();
    ownerId = owner!.id;

    const saved = await page.request.post('/api/reading/save', {
      data: {
        url: 'https://example.com/synthetic-live-personal-knowledge',
        title,
        quote,
        note: `${initialNote} ${marker}`,
        tags: ['e2e'],
        idempotencyKey: randomUUID(),
      },
    });
    expect(saved.status()).toBe(201);
    researchId = (await saved.json() as { draft: { id: string } }).draft.id;

    const stored = await prisma.research.findUnique({
      where: { id: researchId },
      select: { knowledgeIndexText: true },
    });
    expect(stored?.knowledgeIndexText).toContain(marker);
    expect(stored?.knowledgeIndexText).not.toContain(quote);

    let task = await getIndexTask(researchId);
    expect(task).toMatchObject({ status: 'queued', operation: 'upsert', generation: 1 });
    runIndexTask(task.id);
    task = await getIndexTask(researchId);
    expect(task).toMatchObject({ status: 'completed', operation: 'upsert', generation: 1 });
    expect(task.documentPath).toBeTruthy();

    // Simulate a crash after the remote upload but before its random path was
    // committed to the outbox row. The next run must find and replace it.
    await prisma.personalKnowledgeIndexTask.update({
      where: { researchId },
      data: {
        status: 'queued',
        workspaceSlug: null,
        documentPath: null,
        contentHash: null,
        attempts: 0,
        nextRetryAt: null,
        lockedBy: null,
        leaseExpiresAt: null,
        lastError: null,
      },
    });
    runIndexTask(task.id);
    task = await getIndexTask(researchId);
    expect(task).toMatchObject({ status: 'completed', operation: 'upsert', generation: 1 });
    expect(task.documentPath).toBeTruthy();

    const semanticResults = await getContext(page, initialQuery);
    expect(semanticResults.items).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: researchId, kind: 'knowledge', private: true, semanticMatch: true }),
    ]));

    const otherContext = await browser.newContext({ baseURL: BASE_URL });
    try {
      await loginWithCredentials(otherContext.request, {
        email: 'e2e-admin@e2e.local',
        role: 'admin',
      });
      const otherResults = await otherContext.request.get('/api/ai-research/context', {
        params: { q: initialQuery },
      });
      expect(otherResults.status()).toBe(200);
      expect((await otherResults.json() as { items: Array<{ id: string }> }).items)
        .not.toEqual(expect.arrayContaining([expect.objectContaining({ id: researchId })]));
    } finally {
      await otherContext.close();
    }

    const submitted: { current: Record<string, unknown> | null } = { current: null };
    await page.route('**/api/ai-research/plan', (route) => route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        assistantMessage: '研究方案已准备好。',
        brief: {
          objective: 'investigate',
          question: initialQuery,
          constraints: [],
          questionsToAnswer: ['如何避免不确定结果下的重复操作'],
          comparisonOptions: [],
          successCriteria: [],
          sourcePolicy: 'prefer_user_sources',
          contextRefs: [],
          primaryTopicId: null,
          outputType: 'markdown',
        },
        plan: { summary: '检查超时后的重复操作风险。', steps: [], estimatedMinutes: 5 },
        ready: true,
        missingFields: [],
        suggestedTopics: [],
        suggestedContext: [],
      }),
    }));
    await page.route('**/api/ai-research', async (route) => {
      if (route.request().method() !== 'POST') return route.continue();
      submitted.current = route.request().postDataJSON() as Record<string, unknown>;
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ jobId: randomUUID() }),
      });
    });

    await page.goto('/ai-research');
    const input = page.getByRole('textbox', { name: 'AI 调研对话输入' });
    const createdConversation = page.waitForResponse((response) =>
      new URL(response.url()).pathname === '/api/ai-research/conversations' &&
      response.request().method() === 'POST',
    );
    await input.fill(initialQuery);
    await page.getByRole('button', { name: '发送消息（AI 调研）' }).click();
    const conversationResponse = await createdConversation;
    expect(conversationResponse.status()).toBe(201);
    conversationId = (await conversationResponse.json() as { id: string }).id;
    await input.fill('请检查这个判断的适用条件和来源边界');
    await page.getByRole('button', { name: '发送消息（AI 调研）' }).click();
    await expect(page.getByText('研究方案', { exact: true })).toBeVisible();
    await waitForHydration(page);

    const details = page.locator('details').filter({ hasText: '已有资料（可选）' });
    await expect(details).toHaveCount(1);
    const contextSummary = details.locator('summary');
    const contextResponse: { current: Response | null } = { current: null };
    page.on('response', (response) => {
      if (new URL(response.url()).pathname === '/api/ai-research/context') contextResponse.current = response;
    });
    await contextSummary.click();
    await expect(details).toHaveAttribute('open', '');
    await expect.poll(() => contextResponse.current).not.toBeNull();
    expect(contextResponse.current?.status()).toBe(200);

    const source = page.getByRole('button', { name: new RegExp(title) });
    await expect(source).toBeVisible();
    await expect(source).toContainText('语义匹配');
    await expect(source).toContainText('仅本人');
    await expect(source).toHaveAttribute('aria-pressed', 'false');
    await source.click();
    await expect(source).toHaveAttribute('aria-pressed', 'true');
    await page.getByRole('button', { name: '开始调研' }).click();
    await expect.poll(() => submitted.current).not.toBeNull();
    expect(submitted.current?.sourceRefs).toEqual([
      { type: 'research', value: researchId, required: false },
    ]);

    const revisedBody = `> ${quote}\n\n## 我的笔记\n\n${revisedNote}`;
    const edited = await page.request.put(`/api/researches/${researchId}`, {
      data: { body: revisedBody },
    });
    expect(edited.status()).toBe(200);
    task = await getIndexTask(researchId);
    expect(task).toMatchObject({ status: 'queued', operation: 'upsert', generation: 2 });
    runIndexTask(task.id);
    task = await getIndexTask(researchId);
    expect(task).toMatchObject({ status: 'completed', operation: 'upsert', generation: 2 });

    expect((await getContext(page, initialQuery)).items)
      .not.toEqual(expect.arrayContaining([expect.objectContaining({ id: researchId })]));
    expect((await getContext(page, revisedQuery)).items).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: researchId, semanticMatch: true }),
    ]));

    const deletion = await page.request.delete(`/api/researches/${researchId}`);
    expect(deletion.status()).toBe(200);
    task = await getIndexTask(researchId);
    expect(task).toMatchObject({ status: 'queued', operation: 'delete', generation: 3 });
    await prisma.personalKnowledgeIndexTask.update({
      where: { researchId },
      data: { workspaceSlug: null, documentPath: null },
    });
    runIndexTask(task.id, ownerId!);
    task = await getIndexTask(researchId);
    expect(task).toMatchObject({ status: 'completed', operation: 'delete', generation: 3 });
    expect((await getContext(page, revisedQuery)).items)
      .not.toEqual(expect.arrayContaining([expect.objectContaining({ id: researchId })]));
  } finally {
    try {
      if (researchId && ownerId) {
        const remaining = await prisma.research.findUnique({ where: { id: researchId }, select: { id: true } });
        if (remaining) {
          const response = await page.request.delete(`/api/researches/${researchId}`);
          expect([200, 404]).toContain(response.status());
        }
        const task = await prisma.personalKnowledgeIndexTask.findUnique({
          where: { researchId },
          select: { id: true, operation: true, status: true },
        });
        if (task?.operation === 'delete' && task.status !== 'completed') {
          runIndexTask(task.id, ownerId);
        }
        const finalTask = await prisma.personalKnowledgeIndexTask.findUnique({
          where: { researchId },
          select: { operation: true, status: true },
        });
        if (finalTask?.status !== 'completed' || finalTask.operation !== 'delete') {
          throw new Error('synthetic personal knowledge cleanup did not reach a completed delete state');
        }
      }
    } finally {
      if (conversationId) {
        await prisma.aiResearchConversation.deleteMany({ where: { id: conversationId } });
      }
      if (ownerId) {
        await prisma.user.deleteMany({ where: { id: ownerId } }).catch(() => undefined);
      }
    }
  }
});

test('a selected AI research judgment is indexed, replaced, and removed with its source trail', async ({ page }) => {
  test.setTimeout(180_000);
  const email = `personal-card-${randomUUID().replaceAll('-', '')}@e2e.local`;
  const title = `E2E selected judgment ${randomUUID().slice(0, 8)}`;
  const jobId = randomUUID();
  const sourceUrl = 'https://example.com/synthetic-selected-judgment';
  const selectedText = 'For uncertain remote writes, preserve the same idempotency token across retries so a timeout cannot create a duplicate operation.';
  const initialConclusion = 'Retries after an uncertain result must reuse the original idempotency token.';
  const initialQuery = 'How do we prevent a timed out remote write from creating duplicate operations?';
  const revisedConclusion = 'For incompatible schema changes, deploy an additive migration before switching readers and writers.';
  const revisedQuery = 'How can a production database schema change be rolled out safely across mixed application versions?';
  let ownerId: string | null = null;
  let reportId: string | null = null;
  let knowledgeId: string | null = null;

  await loginWithCredentials(page.context().request, { email, role: 'member' });
  try {
    const owner = await prisma.user.findUnique({ where: { email }, select: { id: true } });
    expect(owner).not.toBeNull();
    ownerId = owner!.id;

    const report = await prisma.research.create({
      data: {
        type: 'research',
        status: 'draft',
        title: 'Synthetic source report for selected judgment',
        body: `## Judgment\n\n${selectedText}`,
        authorId: ownerId,
        aiAssisted: true,
        creationMethod: 'ai_research',
        researchSources: {
          create: [{
            sourceRef: { type: 'url', value: sourceUrl },
            canonicalKey: sourceUrl,
            title: 'Synthetic idempotency reference',
            description: 'Synthetic source used by the live test.',
          }],
        },
      },
      select: { id: true },
    });
    reportId = report.id;

    await page.route(`**/api/ai-research/${jobId}`, (route) => route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        jobId,
        status: 'succeeded',
        finalStatus: 'succeeded',
        currentStep: 'write',
        topic: title,
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
        startedAt: new Date().toISOString(),
        createdAt: new Date().toISOString(),
        completedAt: new Date().toISOString(),
        draftResearchId: report.id,
        review: { phase: 'completed', status: 'passed', attempts: 1, corrected_count: 0, unverified_count: 0, contradicted_count: 0, claims: [] },
        conversation: [],
        sources: [],
        artifact: {
          type: 'markdown',
          title,
          version: 1,
          mimeType: 'text/markdown',
          content: `## Judgment\n\n${selectedText}`,
          rawContent: null,
          payload: null,
          sourceRefs: [{ type: 'url', value: sourceUrl, title: 'Synthetic idempotency reference' }],
          sourceHash: null,
          draftResearchId: report.id,
        },
      }),
    }));
    await page.route(`**/api/ai-research/conversations/by-job/${jobId}`, (route) =>
      route.fulfill({ status: 404, body: 'not found' }),
    );
    await page.route('**/api/knowledge/derive', (route) => route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        preview: {
          title: 'Confirmed judgment',
          body: `Confirmed judgment\n\n${initialConclusion}`,
          conclusion: initialConclusion,
          tags: ['e2e'],
        },
      }),
    }));

    await page.goto(`/ai-research/${jobId}`);
    const reportSource = page.locator(`[data-knowledge-source-message="${report.id}"]`);
    await expect(reportSource).toContainText(selectedText);
    await reportSource.evaluate((root, selected) => {
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
      let node: Node | null;
      while ((node = walker.nextNode())) {
        const text = node.textContent ?? '';
        const start = text.indexOf(selected);
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
      throw new Error('Could not select the synthetic report judgment');
    }, selectedText);
    await page.getByRole('button', { name: '存为知识' }).click();
    await expect(page.getByText('知识卡片预览')).toBeVisible();
    await expect(page.getByLabel('本次提炼所选原文')).toContainText(selectedText);
    await page.getByLabel('标题').fill(title);
    const saveResponse = page.waitForResponse((response) =>
      new URL(response.url()).pathname === '/api/knowledge' &&
      response.request().method() === 'POST',
    );
    await page.getByRole('button', { name: '保存知识卡片' }).click();
    const saved = await saveResponse;
    expect(saved.status()).toBe(201);
    const savedBody = await saved.json() as { knowledge: { id: string; status: string } };
    knowledgeId = savedBody.knowledge.id;
    expect(savedBody.knowledge.status).toBe('draft');
    await expect(page.getByText('已保存知识卡片')).toBeVisible();

    const initialRecord = await prisma.research.findUnique({
      where: { id: knowledgeId },
      select: { knowledgeIndexText: true },
    });
    expect(initialRecord?.knowledgeIndexText).toContain(initialConclusion);
    expect(initialRecord?.knowledgeIndexText).not.toContain(selectedText);

    let task = await getIndexTask(knowledgeId);
    expect(task).toMatchObject({ operation: 'upsert', status: 'queued', generation: 1 });
    runIndexTask(task.id);
    task = await getIndexTask(knowledgeId);
    expect(task).toMatchObject({ operation: 'upsert', status: 'completed', generation: 1 });
    expect(task.documentPath).toBeTruthy();
    expect((await getContext(page, initialQuery)).items).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: knowledgeId, kind: 'knowledge', private: true, semanticMatch: true }),
    ]));

    const detail = await page.request.get(`/api/researches/${knowledgeId}`);
    expect(detail.status()).toBe(200);
    expect((await detail.json() as { researchSources: Array<{ canonicalKey: string }> }).researchSources)
      .toEqual(expect.arrayContaining([expect.objectContaining({ canonicalKey: sourceUrl })]));

    const revisedBody = `Confirmed judgment\n\n${revisedConclusion}`;
    const edited = await page.request.put(`/api/researches/${knowledgeId}`, {
      data: { body: revisedBody, conclusion: revisedConclusion },
    });
    expect(edited.status()).toBe(200);
    const revisedRecord = await prisma.research.findUnique({
      where: { id: knowledgeId },
      select: { knowledgeIndexText: true },
    });
    expect(revisedRecord?.knowledgeIndexText).toContain(revisedConclusion);
    expect(revisedRecord?.knowledgeIndexText).not.toContain(initialConclusion);

    task = await getIndexTask(knowledgeId);
    expect(task).toMatchObject({ operation: 'upsert', status: 'queued', generation: 2 });
    runIndexTask(task.id);
    task = await getIndexTask(knowledgeId);
    expect(task).toMatchObject({ operation: 'upsert', status: 'completed', generation: 2 });
    expect((await getContext(page, initialQuery)).items)
      .not.toEqual(expect.arrayContaining([expect.objectContaining({ id: knowledgeId })]));
    expect((await getContext(page, revisedQuery)).items).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: knowledgeId, semanticMatch: true }),
    ]));

    const deletion = await page.request.delete(`/api/researches/${knowledgeId}`);
    expect(deletion.status()).toBe(200);
    task = await getIndexTask(knowledgeId);
    expect(task).toMatchObject({ operation: 'delete', status: 'queued', generation: 3 });
    runIndexTask(task.id, ownerId!);
    task = await getIndexTask(knowledgeId);
    expect(task).toMatchObject({ operation: 'delete', status: 'completed', generation: 3 });
    expect(task.documentPath).toBeNull();
    expect((await getContext(page, revisedQuery)).items)
      .not.toEqual(expect.arrayContaining([expect.objectContaining({ id: knowledgeId })]));
  } finally {
    if (knowledgeId && ownerId) {
      const existing = await prisma.research.findUnique({ where: { id: knowledgeId }, select: { id: true } });
      if (existing) {
        const response = await page.request.delete(`/api/researches/${knowledgeId}`);
        expect([200, 404]).toContain(response.status());
      }
      const task = await prisma.personalKnowledgeIndexTask.findUnique({
        where: { researchId: knowledgeId },
        select: { id: true, operation: true, status: true },
      });
      if (task?.operation === 'delete') runIndexTask(task.id, ownerId);
    }
    if (reportId) await prisma.research.deleteMany({ where: { id: reportId } });
    if (ownerId) await prisma.user.deleteMany({ where: { id: ownerId } }).catch(() => undefined);
  }
});

test.afterAll(async () => {
  await prisma.$disconnect();
});
