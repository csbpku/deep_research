import {
  test as base, expect, type BrowserContext, type Locator, type Page, type TestInfo,
} from '@playwright/test';
import { isolatedMuiOrigin, loginMuiFixture } from './mui-local-fixtures';

const ORIGIN = process.env.MUI_ISOLATED_BROWSER === '1' ? isolatedMuiOrigin() : '';
const DRAFT_ID = '10000000-0000-4000-8000-000000000091';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const zeroCounts = { favorite: 0, useful: 0, inaccurate: 0, used: 0, suggest_research: 0 };
const fallbackCandidate = {
  id: '10000000-0000-4000-8000-000000000090',
  title: '知识复用验收：区分来源摘要与个人判断',
  url: 'https://example.com/knowledge-reuse',
  excerpt: '来源摘录只提供背景，不能自动成为用户自己的判断。',
  interpretation: 'AI 摘要：需要用独立实验确认来源中的性能主张。',
  scoreReason: null, distilledScore: null, tier: 'deep_read', selectionReason: null,
  sourceType: 'rss', sourceName: '隔离验收来源', originalKind: 'article',
  tags: [], status: 'published', publishedAt: null, crawledAt: '2026-10-20T00:00:00Z',
  relevanceScore: null, timelinessScore: null, sourceQualityScore: null, sortOrder: null,
  commentCount: 0, topics: [], issues: [], feedbackCounts: zeroCounts, myFeedbacks: [],
};
type RadarFixture = Omit<typeof fallbackCandidate, 'interpretation'> & { interpretation: string | null };
type SavePayload = {
  url: string; radarSummaryId: string; quote: string; note: string; idempotencyKey: string;
};

// Playwright owns these fresh contexts; no persistent profile, storage-state file,
// shared browser tab, sign-out, or cookie clearing touches the user's session.
const test = base.extend<{ mutationGuard: void; runtimeGuard: void }>({
  mutationGuard: [async ({ context }, use) => {
    const unexpected: string[] = [];
    await context.route('**/api/**', async route => {
      const request = route.request();
      if (['GET', 'HEAD', 'OPTIONS'].includes(request.method())) return route.fallback();
      unexpected.push(`${request.method()} ${new URL(request.url()).pathname}`);
      await route.abort('blockedbyclient');
    });
    // loginMuiFixture uses context.request, not a page request. Only normal
    // authentication against the isolated fixture service bypasses this guard.
    await use();
    expect(unexpected, 'Unexpected page mutation was blocked before reaching the server').toEqual([]);
  }, { auto: true }],
  runtimeGuard: [async ({ page }, use) => {
    const errors: string[] = [];
    page.on('pageerror', error => errors.push(error.message));
    page.on('console', message => {
      if (message.type() === 'error' && /hydration|did not match|server rendered/i.test(message.text())) {
        errors.push(message.text());
      }
    });
    await use();
    expect(errors, 'Runtime and hydration errors').toEqual([]);
  }, { auto: true }],
});

test.use({ storageState: { cookies: [], origins: [] }, serviceWorkers: 'block' });

async function screenshot(page: Page, info: TestInfo, name: string) {
  const path = info.outputPath(`${name}.png`);
  await page.screenshot({ path, fullPage: true, animations: 'disabled' });
  await info.attach(name, { path, contentType: 'image/png' });
}

async function noOverflow(page: Page, dialog?: Locator) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  if (dialog) {
    expect(await dialog.evaluate(element => {
      const bounds = element.getBoundingClientRect();
      return bounds.left >= 0 && bounds.right <= innerWidth
        && element.scrollWidth <= element.clientWidth + 1;
    })).toBe(true);
  }
}

async function radarFixture(context: BrowserContext, info: TestInfo): Promise<RadarFixture> {
  // Read real synthetic candidates first. Empty fixture databases need no seed
  // mutation: fall back to the same list/detail shape as mui-radar.spec.ts.
  const response = await context.request.get(`${ORIGIN}/api/radar?quality=all&per_page=20`);
  expect(response.ok(), 'The real isolated radar API must remain healthy').toBe(true);
  const data = await response.json() as { items?: RadarFixture[] };
  const candidate = data.items?.find(item =>
    UUID.test(item.id) && Boolean(item.title) && /^https?:\/\//.test(item.url),
  );
  info.annotations.push({
    type: 'radar-fixture',
    description: candidate ? `Read-only fixture API candidate: ${candidate.id}` : 'Empty radar: deterministic mui-radar fallback',
  });
  return {
    ...fallbackCandidate, ...candidate,
    interpretation: candidate?.interpretation?.trim() || fallbackCandidate.interpretation,
    // Deliberate response-only normalization for the zero-count acceptance.
    feedbackCounts: { ...zeroCounts }, myFeedbacks: [],
  };
}

async function mockRadar(page: Page, candidate: RadarFixture, authenticated: boolean) {
  await page.route(url => url.origin === ORIGIN && url.pathname === '/api/radar',
    route => route.fulfill({ json: {
      page: 1, perPage: 20, total: 1, totalPages: 1, items: [candidate],
    } }));
  await page.route(url => url.origin === ORIGIN && url.pathname === `/api/radar/${candidate.id}`,
    route => route.fulfill({ json: { ...candidate, isAuthenticated: authenticated } }));
}

async function mockPreviousJudgment(page: Page, candidate: RadarFixture, identity: 'admin' | 'member') {
  const judgment = {
    id: identity === 'admin' ? '10000000-0000-4000-8000-000000000092' : '10000000-0000-4000-8000-000000000093',
    title: `${identity} 之前保存的判断`,
    conclusion: `${identity} 的个人判断：先验证吞吐与延迟，再决定是否采用。`,
    status: 'draft', private: true, updatedAt: '2026-10-20T08:00:00.000Z',
    matchReason: '同一来源',
  };
  const reads: string[] = [];
  await page.route(url => url.origin === ORIGIN && url.pathname === '/api/knowledge/related', route => {
    expect(route.request().method()).toBe('GET');
    const summaryId = new URL(route.request().url()).searchParams.get('radarSummaryId');
    expect(summaryId).toBe(candidate.id);
    reads.push(summaryId!);
    return route.fulfill({ json: { items: [judgment] } });
  });
  return { judgment, reads };
}

async function openRadar(page: Page, candidate: RadarFixture, surface: 'preview' | 'detail') {
  await page.goto('/radar?date=all');
  const card = page.getByRole('article').filter({
    has: page.getByRole('link', { name: candidate.title, exact: true }),
  });
  const favorite = card.getByRole('button', { name: '收藏（0）', exact: true });
  await expect(favorite).toBeVisible();
  await expect(favorite).toHaveText('收藏');
  await expect(favorite).toHaveAttribute('aria-pressed', 'false');
  if (surface === 'detail') {
    await page.goto(`/radar/${candidate.id}?from=date%3Dall`);
    await expect(page.getByRole('heading', { level: 1, name: candidate.title, exact: true })).toBeVisible();
    return page.getByRole('main');
  }
  // Exercise the actual title-to-preview path, including detail authentication.
  // Do not inject isAuthenticated into the list to hide a stale preview bug.
  await card.getByRole('link', { name: candidate.title, exact: true }).click();
  return page.getByRole('complementary', { name: '文章概览', exact: true }).filter({ visible: true });
}

async function expectLogin(panel: Locator, callbackUrl: string) {
  const login = panel.getByRole('link', { name: '登录', exact: true });
  await expect(login).toBeVisible();
  const url = new URL((await login.getAttribute('href'))!, ORIGIN);
  expect(url.pathname).toBe('/signin');
  expect(url.searchParams.get('callbackUrl')).toBe(callbackUrl);
  await expect(panel.getByRole('button', { name: /重试|重新读取/ })).toHaveCount(0);
}

async function observeNoRetries(page: Page, snapshot: () => unknown, expected: unknown) {
  // Exercise passive refetch signals, then advance past retry and poll windows.
  await page.evaluate(() => {
    window.dispatchEvent(new Event('online'));
    document.dispatchEvent(new Event('visibilitychange'));
  });
  await page.clock.runFor(30_000);
  expect(snapshot()).toEqual(expected);
}

test.describe('Knowledge reuse and frontend trust acceptance', () => {
  test.skip(process.env.MUI_ISOLATED_BROWSER !== '1', 'Requires the isolated synthetic fixture database');
  test.beforeEach(async ({ page, baseURL }) => {
    expect(isolatedMuiOrigin()).toBe(ORIGIN);
    expect(baseURL, 'Never authenticate against the ordinary development server').toBe(ORIGIN);
    await page.emulateMedia({ reducedMotion: 'reduce' });
  });

  for (const viewport of [
    { name: 'desktop', width: 1440, height: 900, mobile: false },
    { name: 'mobile', width: 390, height: 844, mobile: true },
  ]) {
    test.describe(viewport.name, () => {
      test.use({
        viewport: { width: viewport.width, height: viewport.height },
        isMobile: viewport.mobile, hasTouch: viewport.mobile,
      });

      for (const identity of ['admin', 'member'] as const) {
        for (const surface of ['preview', 'detail'] as const) {
          test(`${identity}: ${surface} requires an explicit judgment and reuses owner history`, async ({ page, context }, info) => {
            await loginMuiFixture(context.request, identity);
            const candidate = await radarFixture(context, info);
            await mockRadar(page, candidate, true);
            const { judgment, reads } = await mockPreviousJudgment(page, candidate, identity);
            const writes: SavePayload[] = [];
            await page.route(url => url.origin === ORIGIN && url.pathname === '/api/reading/save', route => {
              expect(route.request().method()).toBe('POST');
              writes.push(route.request().postDataJSON() as SavePayload);
              return route.fulfill({ status: 201, json: {
                ok: true, draft: { id: DRAFT_ID, title: candidate.title, status: 'draft', createdAt: '2026-10-20T08:00:00Z' },
              } });
            });

            const panel = await openRadar(page, candidate, surface);
            await expect.poll(() => panel.evaluate(element => element.scrollWidth <= element.clientWidth + 1)).toBe(true);
            const previous = panel.getByRole('region', { name: '你之前的判断', exact: true });
            await expect(previous).toBeVisible();
            await expect(previous.getByRole('link', { name: judgment.title, exact: true }))
              .toHaveAttribute('href', `/researches/${judgment.id}`);
            await expect(previous).toContainText(judgment.conclusion);
            await expect(previous).toContainText('同一来源');
            await expect(previous).toContainText('仅本人');
            expect(reads.length).toBeGreaterThan(0);
            expect(writes).toEqual([]);
            await previous.getByRole('link', { name: judgment.title, exact: true }).focus();
            await noOverflow(page);
            await screenshot(page, info, `${identity}-${surface}-previous-judgments`);

            const trigger = panel.getByRole('button', { name: '记录判断', exact: true });
            await trigger.click();
            const dialog = page.getByRole('dialog', { name: '记录判断', exact: true });
            const quote = dialog.getByRole('textbox', { name: '来源摘录 / AI 摘要', exact: true });
            const note = dialog.getByRole('textbox', { name: '我的判断', exact: true });
            const save = dialog.getByRole('button', { name: '保存判断', exact: true });
            const expectedQuote = (candidate.interpretation || candidate.excerpt || candidate.title).slice(0, 12000);
            await expect(quote).toHaveValue(expectedQuote);
            await expect(quote).toHaveJSProperty('readOnly', true);
            await expect(note).toHaveValue('');
            await expect(note).toBeFocused();
            await expect(save).toBeDisabled();
            await note.fill(' \n  ');
            await expect(save).toBeDisabled();
            expect(writes).toEqual([]);

            // Escape must not save or silently turn the summary into a judgment.
            await page.keyboard.press('Escape');
            await expect(dialog).not.toBeVisible();
            await expect(trigger).toBeFocused();
            expect(writes).toEqual([]);
            await trigger.click();
            await expect(note).toHaveValue('');
            const personalNote = `我的判断（${identity}）：只在完成本地基准复现后采用，不能把摘要当成已验证结论。`;
            await note.fill(`  ${personalNote}  `);
            await expect(save).toBeEnabled();
            await noOverflow(page, dialog);
            await screenshot(page, info, `${identity}-${surface}-explicit-note`);
            await save.click();

            await expect(dialog.getByRole('alert')).toContainText('已保存，仅你可见。');
            await expect(dialog.getByRole('link', { name: '查看知识卡', exact: true }))
              .toHaveAttribute('href', `/researches/${DRAFT_ID}`);
            expect(writes).toHaveLength(1);
            expect(writes[0]).toMatchObject({
              url: candidate.url, radarSummaryId: candidate.id,
              quote: expectedQuote, note: personalNote, idempotencyKey: expect.stringMatching(UUID),
            });
            expect(writes[0]).not.toHaveProperty('aiAnswer');
            expect(writes[0]!.note).not.toBe(expectedQuote);
            await screenshot(page, info, `${identity}-${surface}-saved-private-draft`);
            // The draft is mocked; inspect its destination without navigating to a nonexistent DB row.
          });
        }
      }

      test('anonymous radar never exposes owner-only history or a judgment composer', async ({ page }, info) => {
        const candidate = { ...fallbackCandidate };
        await mockRadar(page, candidate, false);
        const relatedReads: string[] = [];
        await page.route('**/api/knowledge/related?*', route => {
          relatedReads.push(route.request().url());
          return route.fulfill({ json: { items: [] } });
        });
        for (const surface of ['preview', 'detail'] as const) {
          const panel = await openRadar(page, candidate, surface);
          await expect(panel).toBeVisible();
          await expect(panel.getByRole('button', { name: '记录判断', exact: true })).toHaveCount(0);
          await expect(panel.getByRole('region', { name: '你之前的判断' })).toHaveCount(0);
          await noOverflow(page);
          await screenshot(page, info, `anonymous-radar-${surface}`);
        }
        expect(relatedReads).toEqual([]);
      });

      test('anonymous research 401 offers a callback login without retries or a false empty state', async ({ page }, info) => {
        await page.clock.install();
        const reads: string[] = [];
        await page.route('**/api/researches?*', route => {
          reads.push(new URL(route.request().url()).searchParams.get('scope')!);
          return route.fulfill({ status: 401, json: { code: 'AUTH_NOT_AUTHENTICATED', message: '请先登录' } });
        });
        for (const tab of ['', 'draft', 'mine']) {
          const path = `/researches${tab ? `?tab=${tab}` : ''}`;
          await page.goto(path);
          const panel = page.getByRole('tabpanel');
          await expect(panel).toContainText('登录后查看研究库。');
          await expectLogin(panel, path);
          await expect(panel).not.toContainText(/暂无草稿|暂无成果|暂无我的已发布|暂时无法加载/);
          await noOverflow(page);
          await screenshot(page, info, `anonymous-research-${tab || 'published'}`);
        }
        expect(reads).toEqual(['published', 'draft', 'mine']);
        await observeNoRetries(page, () => reads, ['published', 'draft', 'mine']);
      });

      for (const history of [false, true]) {
        test(`anonymous AI 401 keeps login actionable (${history ? 'history' : 'recent tasks'})`, async ({ page }, info) => {
          await page.clock.install();
          const reads = { conversations: 0, recent: 0, history: 0 };
          await page.route(url => url.origin === ORIGIN && url.pathname === '/api/ai-research/conversations', route => {
            expect(route.request().method()).toBe('GET');
            reads.conversations++;
            return route.fulfill({ status: 401, json: { code: 'AUTH_NOT_AUTHENTICATED' } });
          });
          await page.route('**/api/ai-research/jobs?*', route => {
            const recent = new URL(route.request().url()).searchParams.get('limit') === '3';
            reads[recent ? 'recent' : 'history']++;
            return history && recent
              ? route.fulfill({ json: { items: [], total: 0 } })
              : route.fulfill({ status: 401, json: { code: 'AUTH_NOT_AUTHENTICATED' } });
          });
          await page.goto(history ? '/ai-research?history=1' : '/ai-research');
          const panel = history
            ? page.getByRole('dialog', { name: '调研历史', exact: true })
            : page.getByRole('region', { name: '最近任务', exact: true });
          await expect(panel).toContainText(history ? '登录后查看历史任务。' : '登录后查看最近任务。');
          await expectLogin(panel, '/ai-research');
          await expect(panel).not.toContainText(/加载失败|暂时无法加载|还没有调研任务/);
          await noOverflow(page, history ? panel : undefined);
          await screenshot(page, info, `anonymous-ai-${history ? 'history' : 'recent'}`);
          if (history) await page.getByRole('button', { name: '关闭调研历史', exact: true }).click();
          const conversations = page.getByRole('complementary', { name: '最近对话', exact: true });
          await expect(conversations).toContainText('登录后查看最近对话。');
          await expectLogin(conversations, '/ai-research');
          await expect(conversations).not.toContainText('对话自动保存，可随时回来继续');
          expect(reads).toEqual({ conversations: 1, recent: 1, history: history ? 1 : 0 });
          await observeNoRetries(page, () => reads, { conversations: 1, recent: 1, history: history ? 1 : 0 });
        });
      }

      test('recent tasks lead with the topic and result while keeping the review gate visible', async ({ page, context }, info) => {
        await loginMuiFixture(context.request, 'member');
        await page.route('**/api/ai-research/conversations', route => route.fulfill({ json: { items: [] } }));
        const topic = '验证检索引擎的吞吐与延迟';
        await page.route('**/api/ai-research/jobs?*', route => route.fulfill({ json: { items: [{
          jobId: '10000000-0000-4000-8000-000000000094', topic, status: 'succeeded',
          currentStep: null, reportType: 'research_report', reportLength: 'standard',
          hasReport: true, reviewStatus: 'needs_action', capturedSourcesCount: 3,
          deliverableStatus: 'report', sourcePolicy: 'web_only', sourceRefs: [],
          draftResearchId: null, publishedResearchId: null, createdAt: '2026-10-20T08:00:00Z',
        }], total: 1 } }));
        await page.goto('/ai-research');
        const recent = page.getByRole('region', { name: '最近任务', exact: true });
        const article = recent.getByRole('article');
        await expect(article.getByRole('heading', { name: topic, exact: true })).toBeVisible();
        await expect(article.getByRole('link', { name: '查看结果', exact: true })).toBeVisible();
        await expect(article).toContainText('需要确认');
        await expect(article).not.toContainText(/可以直接参考|已验证|结论：/);
        expect(await article.evaluate(element => {
          const heading = element.querySelector('h3')!;
          const result = Array.from(element.querySelectorAll('a')).find(link => link.textContent === '查看结果')!;
          const status = Array.from(element.querySelectorAll('*')).find(node => node.textContent === '需要确认')!;
          return Boolean(heading.compareDocumentPosition(result) & Node.DOCUMENT_POSITION_FOLLOWING)
            && Boolean(result.compareDocumentPosition(status) & Node.DOCUMENT_POSITION_FOLLOWING);
        })).toBe(true);
        await noOverflow(page);
        await screenshot(page, info, 'recent-topic-result-review-gate');
      });
    });
  }

  test('a failed save retains the personal note and retries with the same idempotency key', async ({ page, context }) => {
    await loginMuiFixture(context.request, 'member');
    const candidate = { ...fallbackCandidate };
    await mockRadar(page, candidate, true);
    await mockPreviousJudgment(page, candidate, 'member');
    const writes: SavePayload[] = [];
    await page.route(url => url.origin === ORIGIN && url.pathname === '/api/reading/save', route => {
      expect(route.request().method()).toBe('POST');
      writes.push(route.request().postDataJSON() as SavePayload);
      return writes.length === 1
        ? route.fulfill({ status: 503, json: { message: '保存暂时不可用，请重试。' } })
        : route.fulfill({ status: 201, json: {
          draft: { id: DRAFT_ID, title: candidate.title, status: 'draft' },
        } });
    });
    const panel = await openRadar(page, candidate, 'detail');
    await panel.getByRole('button', { name: '记录判断', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: '记录判断', exact: true });
    const note = dialog.getByRole('textbox', { name: '我的判断', exact: true });
    await note.fill('我的判断：应先复现实验，暂不直接采用。');
    await dialog.getByRole('button', { name: '保存判断', exact: true }).click();
    await expect(dialog.getByRole('alert')).toHaveText('保存暂时不可用，请重试。');
    await expect(note).toHaveValue('我的判断：应先复现实验，暂不直接采用。');
    await expect(dialog.getByRole('textbox', { name: '来源摘录 / AI 摘要', exact: true }))
      .toHaveValue(candidate.interpretation);
    expect(writes).toHaveLength(1);
    await dialog.getByRole('button', { name: '保存判断', exact: true }).click();
    await expect(dialog.getByRole('alert')).toContainText('已保存，仅你可见。');
    expect(writes).toHaveLength(2);
    expect(writes[1]).toEqual(writes[0]);
    expect(writes[0]!.idempotencyKey).toMatch(UUID);
  });

  for (const status of [403, 503]) {
    test(`HTTP ${status} remains a real failure, not a login or empty state`, async ({ page }) => {
      const code = status === 403 ? 'PERMISSION_DENIED' : 'AI_ENGINE_UNAVAILABLE';
      const fail = { status, json: { code } };
      await page.route('**/api/researches?*', route => route.fulfill(fail));
      await page.goto('/researches');
      const library = page.getByRole('tabpanel');
      await expect(library.getByRole('alert')).toContainText('研究库暂时无法加载');
      await expect(library.getByRole('button', { name: '重试', exact: true })).toBeVisible();
      await expect(library.getByRole('link', { name: '登录', exact: true })).toHaveCount(0);

      await page.route('**/api/ai-research/conversations', route => route.fulfill(fail));
      await page.route('**/api/ai-research/jobs?*', route => route.fulfill(fail));
      await page.goto('/ai-research?history=1');
      const history = page.getByRole('dialog', { name: '调研历史', exact: true });
      await expect(history.getByRole('alert')).toContainText('历史任务加载失败');
      await expect(history.getByRole('button', { name: '重试', exact: true })).toBeVisible();
      await expect(history.getByRole('link', { name: '登录', exact: true })).toHaveCount(0);
      await page.getByRole('button', { name: '关闭调研历史', exact: true }).click();
      const recent = page.getByRole('region', { name: '最近任务', exact: true });
      await expect(recent.getByRole('alert')).toContainText('最近任务暂时无法加载');
      const conversations = page.getByRole('complementary', { name: '最近对话', exact: true });
      await expect(conversations.getByRole('alert')).toContainText('对话列表加载失败');
    });
  }
});
