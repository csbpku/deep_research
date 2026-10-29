import { test, expect, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';

const id = '10000000-0000-4000-8000-000000000001';
const candidate = {
  id, title: '真实雷达结构：长标题与 MUI 交互回归验证', url: 'https://example.com/research',
  excerpt: '这是一条用于确定性 UI 回归的摘要，不触发任何实际业务写入。',
  interpretation: '先呈现摘要，再决定是否打开原文。', scoreReason: null, distilledScore: null,
  tier: 'deep_read', selectionReason: null, sourceType: 'rss', sourceName: '测试来源',
  originalKind: 'article', tags: [], status: 'published', publishedAt: null,
  crawledAt: '2026-10-16T00:00:00Z', relevanceScore: null, timelinessScore: null,
  sourceQualityScore: null, sortOrder: null, commentCount: 0, topics: [], issues: [],
  feedbackCounts: { favorite: 0, useful: 0, inaccurate: 0, used: 0, suggest_research: 0 }, myFeedbacks: [],
};
async function fixture(page: Page) {
  await page.route('**/api/radar?*', route => route.fulfill({ json: { page: 1, perPage: 20, total: 1, totalPages: 1, items: [candidate] } }));
  await page.route(`**/api/radar/${id}?*`, route => route.fulfill({ json: candidate }));
  await page.route('**/api/auth/session', route => route.fulfill({ json: { user: null } }));
}

test.describe('MUI radar migration contracts (no database writes)', () => {
  test.beforeEach(async ({ page }) => { await fixture(page); });

  test('preview hands focus to the panel, closes on Escape and returns focus to the source title', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto('/radar?date=all');
    const title = page.getByRole('link', { name: candidate.title, exact: true });
    await title.click();

    const preview = page.getByRole('complementary', { name: '文章概览', exact: true });
    await expect(preview).toBeVisible();
    // 焦点必须进入预览面板，否则键盘用户要穿过剩下的卡片。
    await expect(preview.getByRole('heading', { level: 2, name: candidate.title })).toBeFocused();

    await page.keyboard.press('Escape');
    await expect.poll(() => new URL(page.url()).searchParams.get('open')).toBeNull();
    await expect(preview).toHaveCount(0);
    // Esc 之后焦点回到来源标题。
    await expect(title).toBeFocused();
  });

  test('preview actions stay aligned and Reader links to the store without the extension', async ({ page }) => {
    await page.route(`**/api/radar/${id}?*`, route => route.fulfill({ json: { ...candidate, isAuthenticated: true } }));
    await page.context().route('https://chromewebstore.google.com/**', route => route.fulfill({ body: 'Reader store fixture' }));
    for (const width of [1440, 390, 320]) {
      await page.setViewportSize({ width, height: 900 });
      await page.goto('/radar?date=all');
      await page.getByRole('link', { name: candidate.title, exact: true }).click();
      const panel = page.locator('aside[aria-label="文章概览"]:visible');
      const buttons = [
        panel.getByRole('button', { name: '记录判断' }),
        panel.getByRole('link', { name: '打开原文' }),
        panel.getByRole('link', { name: '用 Reader 阅读' }),
        panel.getByRole('link', { name: '深入调研' }),
      ];
      for (const button of buttons) await expect(button).toBeVisible();
      const boxes = await Promise.all(buttons.map(button => button.boundingBox()));
      for (const box of boxes) expect(box!.height).toBeGreaterThanOrEqual(44);
      expect(Math.abs(boxes[0]!.width - boxes[1]!.width)).toBeLessThan(1);
      expect(Math.abs(boxes[2]!.width - boxes[3]!.width)).toBeLessThan(1);
      expect(Math.abs(boxes[0]!.y - boxes[1]!.y)).toBeLessThan(1);
      expect(Math.abs(boxes[2]!.y - boxes[3]!.y)).toBeLessThan(1);
      await expect(buttons[2]).toHaveAttribute('href', /chromewebstore\.google\.com\/detail\//u);
      await expect(buttons[2]).toHaveAttribute('data-reader-launch-source', /deep-research-summary=/u);
      if (width === 1440) {
        const [store] = await Promise.all([page.waitForEvent('popup'), buttons[2].click()]);
        await expect(store).toHaveURL(/chromewebstore\.google\.com\/detail\//u);
        await store.close();
      }
    }
  });

  test('the radar card leads with tier and source, then title, then the recommendation', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto('/radar?date=all');
    const card = page.locator('article').first();
    const order = await card.evaluate(element => {
      const text = (node: Element | null) => node?.textContent?.trim() ?? '';
      const tier = Array.from(element.querySelectorAll('.MuiChip-label')).find(node => node.textContent?.includes('精读'));
      const title = element.querySelector('a[href]');
      const teaser = Array.from(element.querySelectorAll('p')).find(node => node.textContent?.includes('先呈现摘要'));
      return {
        tier: tier ? tier.getBoundingClientRect().top : null,
        title: title ? title.getBoundingClientRect().top : null,
        teaser: teaser ? teaser.getBoundingClientRect().top : null,
        sourceBeforeTitle: Boolean(element.querySelector('[data-radar-source]')),
      };
    });
    expect(order.tier).not.toBeNull();
    expect(order.title).not.toBeNull();
    expect(order.teaser).not.toBeNull();
    // 等级 + 来源 → 标题 → 推荐语
    expect(order.tier!).toBeLessThan(order.title!);
    expect(order.title!).toBeLessThan(order.teaser!);
    expect(order.sourceBeforeTitle).toBe(true);
  });

  test('nested menu Escape returns to drawer, then trigger, without losing filters', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto('/radar?date=all');
    const trigger = page.getByRole('button', { name: '筛选', exact: true });
    await trigger.click();
    const drawer = page.getByRole('dialog', { name: '筛选雷达内容' });
    const quality = drawer.getByRole('button', { name: '阅读等级筛选' });
    await quality.click();
    await page.getByRole('menuitemcheckbox', { name: '速读', exact: true }).click();
    await expect(page.getByRole('menuitemcheckbox', { name: '速读', exact: true })).toHaveAttribute('aria-checked', 'true');
    await expect.poll(() => new URL(page.url()).searchParams.get('quality')).toBe('deep_read,skim');
    await page.keyboard.press('Escape');
    await expect(drawer).toBeVisible();
    await expect(quality).toBeFocused();
    await page.keyboard.press('Escape');
    await expect(drawer).not.toBeVisible();
    await expect(trigger).toBeFocused();
  });

  test('native input events, submit and refresh preserve committed search', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto('/radar?date=all');
    const input = page.getByRole('searchbox', { name: '搜索雷达内容' }).filter({ visible: true });
    await input.fill('MUI 原生输入');
    await input.press('Enter');
    await expect.poll(() => new URL(page.url()).searchParams.get('q')).toBe('MUI 原生输入');
    await page.reload();
    await expect(input).toHaveValue('MUI 原生输入');
    // The compact desktop filter row must not be widened by OutlinedInput's
    // default fullWidth rule during the library migration.
    const inputBounds = await input.boundingBox();
    const submitBounds = await page.getByRole('button', { name: '搜索', exact: true }).boundingBox();
    expect(inputBounds?.width).toBeLessThan(300);
    expect(Math.abs((inputBounds?.y ?? 0) - (submitBounds?.y ?? 0))).toBeLessThan(12);
  });

  test('real radar detail keeps the summary-first reading path, expandable score, external Reader prompt and responsive layout', async ({ page }, testInfo) => {
    // Ten theme/viewport combinations include full axe scans and cold dev
    // navigations on CI; this is deliberately broader than one UI interaction.
    test.setTimeout(90_000);
    await page.context().route('https://example.com/research**', route => route.fulfill({
      contentType: 'text/html', body: '<main><h1>Original article fixture</h1></main>',
    }));
    const score = {
      total: 82, tier: 'deep_read', tierScore: 82, rankingScore: 77, qualityScore: 82,
      profile: 'engineering', isDefault: false,
      dimensions: {
        informationGain: 3, analysisDepth: 3, actionability: 2, factualReliability: 3,
        currentApplicability: 2, expressionQuality: 3, audienceFit: 2,
      },
      weakPoint: '需要更多当下案例。', veto: null, riskFlags: [], version: '1',
    };
    await page.route(`**/api/radar/${id}?*`, route => route.fulfill({ json: {
      ...candidate,
      interpretation: '先呈现核心判断，再决定是否继续阅读。',
      selectionReason: '有可复用的实现细节。',
      distilledScore: score,
    } }));

    for (const theme of ['light', 'dark'] as const) {
      for (const width of [1440, 1024, 768, 390, 320]) {
        await page.setViewportSize({ width, height: 900 });
        await page.goto(`/radar/${id}?from=date%3Dall`);
        await page.evaluate(mode => localStorage.setItem('dr-theme', mode), theme);
        await page.reload();
        await expect(page.getByRole('heading', { level: 1, name: candidate.title })).toBeVisible();
        const sourceChip = page.locator('[data-radar-source="articles"]');
        await expect(sourceChip).toHaveText('测试来源');
        await expect(sourceChip).toHaveAttribute('aria-label', 'RSS / 博客订阅');
        await expect(page.getByText('先呈现核心判断，再决定是否继续阅读。')).toBeVisible();
        await expect(page.getByRole('link', { name: '回到雷达' })).toHaveAttribute('href', '/radar?date=all');
        expect(await page.locator('#main-content main').count()).toBe(0);

        const scoreToggle = page.getByRole('button', { name: '查看评分依据' });
        await expect(scoreToggle).toHaveAttribute('aria-expanded', 'false');
        await scoreToggle.focus();
        await page.keyboard.press('Enter');
        await expect(scoreToggle).toHaveAttribute('aria-expanded', 'true');
        await expect(page.getByText('信息增量', { exact: true })).toBeVisible();

        // 打开原文是直链；Reader 安装说明只在显式请求时出现。
        const sourceLink = page.getByRole('link', { name: '打开原文' });
        const sourcePromise = page.waitForEvent('popup');
        await sourceLink.click();
        const sourcePage = await sourcePromise;
        await expect(sourcePage).toHaveURL(/https:\/\/example\.com\/research$/u);
        await expect(sourcePage.getByRole('heading', { name: 'Original article fixture' })).toBeVisible();
        await sourcePage.close();

        // 无扩展时走商店，已安装扩展可从数据属性读取原文。
        const readerLink = page.getByRole('link', { name: '用 Reader 阅读' });
        await expect(readerLink).toHaveAttribute('data-reader-launch-source', /deep-research-summary=/u);
        await expect(readerLink).toHaveAttribute('href', /chromewebstore\.google\.com\/detail\//u);

        expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
        expect((await new AxeBuilder({ page }).include('#main-content').analyze()).violations).toEqual([]);
        if (theme === 'light' && width === 1440) {
          await page.screenshot({ path: testInfo.outputPath('radar-detail-light-1440.png'), fullPage: true });
        }
      }
    }
  });

  test('GitHub repository detail wraps both external actions without clipping on narrow screens', async ({ page }) => {
    await page.route(`**/api/radar/${id}?*`, route => route.fulfill({ json: {
      ...candidate,
      title: 'microsoft/markitdown',
      url: 'https://github.com/microsoft/markitdown',
      sourceType: 'github',
      originalKind: 'github_repo',
    } }));
    await page.setViewportSize({ width: 320, height: 720 });
    await page.goto(`/radar/${id}`);
    await expect(page.getByRole('link', { name: '打开 GitHub' })).toHaveAttribute('href', 'https://github.com/microsoft/markitdown');
    await expect(page.getByRole('link', { name: '打开 Zread' })).toHaveAttribute('href', 'https://zread.ai/microsoft/markitdown');
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    expect((await new AxeBuilder({ page }).include('#main-content').analyze()).violations).toEqual([]);
  });

  test('topic and issue tag icons align with the first label line and retain full text when wrapped', async ({ page }, testInfo) => {
    const topic = { id: 'topic-1', slug: 'rag-retrieval', name: 'RAG 与检索——很长的主题名称用于检查窄屏换行', tier: 'hot' };
    const issue = { id: 'issue-1', title: '编码代理测试与验证技术的实际效果', kind: 'event', importanceScore: 1, topic };
    const fullLabels = [topic.name, issue.title];
    await page.route('**/api/radar?*', route => route.fulfill({ json: {
      page: 1, perPage: 20, total: 1, totalPages: 1, items: [{ ...candidate, topics: [topic], issues: [issue] }],
    } }));
    for (const width of [1440, 390, 320]) {
      await page.setViewportSize({ width, height: 900 });
      await page.goto('/radar?date=all');
      const tags = page.getByRole('article').getByRole('link').filter({ has: page.locator('[data-app-tag-icon="true"]') });
      await expect(tags).toHaveCount(2);
      const lineCounts: number[] = [];
      for (const [index, tag] of (await tags.all()).entries()) {
        const geometry = await tag.evaluate(element => {
          const icon = element.querySelector('svg')!;
          const label = element.querySelector('[data-app-tag-text="true"]')!;
          const outer = element.getBoundingClientRect(), i = icon.getBoundingClientRect(), l = label.getBoundingClientRect();
          const range = document.createRange();
          range.selectNodeContents(label);
          const lines = Array.from(range.getClientRects());
          return {
            firstLineOffset: Math.abs((i.y + i.height / 2) - (lines[0].y + lines[0].height / 2)),
            lineCount: lines.length,
            gap: l.left - i.right, leftInset: i.left - outer.left, rightInset: outer.right - l.right,
            iconWidth: i.width, iconHeight: i.height,
            clipped: label.scrollWidth > label.clientWidth + 1 || label.scrollHeight > label.clientHeight + 1,
          };
        });
        expect(geometry.firstLineOffset).toBeLessThan(2);
        lineCounts.push(geometry.lineCount);
        expect(geometry.gap).toBe(4);
        expect(geometry.iconWidth).toBe(14);
        expect(geometry.iconHeight).toBe(14);
        expect(geometry.leftInset).toBe(geometry.rightInset);
        expect(geometry.clipped).toBe(false);
        await expect(tag).toContainText(fullLabels[index]!);
        await expect(tag).toHaveAttribute('href', '/topics/rag-retrieval');
      }
      if (width === 320) expect(Math.max(...lineCounts)).toBeGreaterThan(1);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      expect((await new AxeBuilder({ page }).include('.material-surface').analyze()).violations).toEqual([]);
      if (width === 390) await page.screenshot({ path: testInfo.outputPath('topic-tag-alignment-390.png') });
    }
  });

  for (const theme of ['light', 'dark'] as const) {
    test(`${theme}: source family colors agree between headers and cards without replacing source labels`, async ({ page }, testInfo) => {
      await page.addInitScript(mode => localStorage.setItem('dr-theme', mode), theme);
      const sourceTypes: Record<string, string> = { github: 'github_release', articles: 'vendor_news', community: 'hackernews', research: 'arxiv', shared: 'web_share' };
      await page.route('**/api/radar?*', route => {
        const group = new URL(route.request().url()).searchParams.get('sourceType') ?? 'github';
        return route.fulfill({ json: { page: 1, perPage: 20, total: 1, totalPages: 1, items: [{
          ...candidate, id: `${id}-${group}`, sourceType: sourceTypes[group] ?? group,
          title: `${group} 来源颜色回归`,
        }] } });
      });
      for (const width of [1440, 390, 320]) {
        await page.setViewportSize({ width, height: 900 });
        await page.goto('/radar?date=all&view=source');
        await expect(page.locator('[data-radar-source]')).toHaveCount(5);
        const colors: string[] = [];
        for (const category of Object.keys(sourceTypes)) {
          const header = page.locator(`[data-radar-source-group="${category}"]`);
          const section = page.getByRole('region').filter({ has: header });
          const chip = section.locator(`[data-radar-source="${category}"]`);
          await expect(chip).toHaveCount(1);
          const color = await chip.evaluate(element => getComputedStyle(element).color);
          expect(await header.getByRole('heading').evaluate(element => getComputedStyle(element, '::before').backgroundColor)).toBe(color);
          expect(await chip.getAttribute('aria-label')).toBeTruthy();
          colors.push(color);
        }
        expect(new Set(colors).size).toBe(5);
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
        expect((await new AxeBuilder({ page }).include('.material-surface').analyze()).violations).toEqual([]);
        if (width === 1440) await page.screenshot({ path: testInfo.outputPath(`source-families-${theme}-1440.png`) });
      }
    });
  }

  test('active radar discussion uses the shared MUI surface and preserves the native, unauthenticated composer contract', async ({ page }) => {
    const comment = {
      id: 'comment-1', body: '这条判断需要和 @Ada 的基准结果对照。', parentId: null, starCount: 1,
      promoteStatus: 'approved', createdAt: '2026-10-19T10:00:00.000Z',
      author: { id: 'member-1', name: 'Lin', avatarUrl: null },
      mentions: [{ id: 'member-2', name: 'Ada', avatarUrl: null }],
      children: [], childCount: 0, anchor: null,
    };
    await page.route('**/api/radar?*', route => route.fulfill({ json: {
      page: 1, perPage: 20, total: 1, totalPages: 1, items: [{ ...candidate, commentCount: 1 }],
    } }));
    await page.route(`**/api/summaries/${id}/comments`, route => route.fulfill({ json: {
      page: 1, perPage: 20, total: 1, totalPages: 1, items: [comment],
    } }));

    await page.goto('/radar?date=all');
    await page.getByRole('button', { name: '1 条讨论', exact: true }).click();
    const section = page.getByTestId('comment-section');
    await expect(section).toBeVisible();
    await expect(section.getByRole('heading', { name: '讨论 (1)' })).toBeVisible();
    await expect(section.getByText('Lin')).toBeVisible();
    await expect(section.getByText('已提炼为知识卡片')).toBeVisible();
    await expect(section.getByText('@Ada')).toBeVisible();
    await expect(section.getByLabel('评论内容，输入 @ 可选择团队成员')).toBeDisabled();
    await expect(section.getByTestId('star-button-comment-1')).toBeDisabled();
    await expect(section).toHaveClass(/MuiPaper-root/);
    expect((await new AxeBuilder({ page }).include('[data-testid="comment-section"]').analyze()).violations).toEqual([]);
  });

  test('authenticated discussion preserves star, member mention, reply and Ctrl+Enter without real writes', async ({ page }) => {
    const initial: {
      id: string; body: string; parentId: string | null; starCount: number; promoteStatus: string; createdAt: string;
      author: { id: string; name: string; avatarUrl: string | null };
      mentions: Array<{ id: string; name: string; avatarUrl: string | null }>;
      children: Array<{
        id: string; body: string; starCount: number; createdAt: string;
        author: { id: string; name: string; avatarUrl: string | null };
        mentions: Array<{ id: string; name: string; avatarUrl: string | null }>;
      }>;
      childCount: number; anchor: null;
    } = {
      id: 'comment-1', body: '可以先复现基准结果。', parentId: null, starCount: 1,
      promoteStatus: 'none', createdAt: '2026-10-19T10:00:00.000Z',
      author: { id: 'member-2', name: 'Lin', avatarUrl: null }, mentions: [],
      children: [], childCount: 0, anchor: null,
    };
    const comments: typeof initial[] = [initial];
    let starred = false;
    const replyPayloads: Array<Record<string, unknown>> = [];
    await page.route('**/api/auth/session', route => route.fulfill({ json: {
      user: { id: 'member-1', name: 'Ada', email: 'ada@example.test', role: 'member', disabledAt: null },
      expires: '2099-01-01T00:00:00.000Z',
    } }));
    await page.route('**/api/radar?*', route => route.fulfill({ json: {
      page: 1, perPage: 20, total: 1, totalPages: 1, items: [{ ...candidate, commentCount: 1 }],
    } }));
    await page.route(`**/api/summaries/${id}/comments`, async route => {
      if (route.request().method() === 'POST') {
        const payload = route.request().postDataJSON() as Record<string, unknown>;
        replyPayloads.push(payload);
        const child = {
          id: 'reply-1', body: payload.body as string, starCount: 0, createdAt: '2026-10-19T10:02:00.000Z',
          author: { id: 'member-1', name: 'Ada', avatarUrl: null },
          mentions: [{ id: 'member-2', name: 'Lin', avatarUrl: null }],
        };
        comments[0] = { ...initial, starCount: starred ? 2 : 1, children: [child], childCount: 1 };
        return route.fulfill({ status: 201, json: child });
      }
      return route.fulfill({ json: { page: 1, perPage: 20, total: 1, totalPages: 1, items: comments } });
    });
    await page.route('**/api/comments/my-stars', route => route.fulfill({ json: { commentIds: starred ? ['comment-1'] : [] } }));
    await page.route('**/api/comments/comment-1/star', async route => {
      starred = route.request().method() === 'POST';
      return route.fulfill({ json: { ok: true, starCount: starred ? 2 : 1 } });
    });
    await page.route('**/api/team-members?q=*', route => route.fulfill({ json: {
      items: [{ id: 'member-2', name: 'Lin', avatarUrl: null, email: 'lin@example.test' }],
    } }));

    await page.goto('/radar?date=all');
    await page.getByRole('button', { name: '1 条讨论', exact: true }).click();
    const section = page.getByTestId('comment-section');
    const star = section.getByTestId('star-button-comment-1');
    await expect(star).toHaveAttribute('aria-pressed', 'false');
    await star.click();
    await expect(star).toHaveAttribute('aria-pressed', 'true');

    await section.getByRole('button', { name: '回复', exact: true }).click();
    const fields = section.getByRole('textbox', { name: '评论内容，输入 @ 可选择团队成员' });
    await expect(fields).toHaveCount(2);
    const reply = fields.nth(1);
    await reply.fill('基准数据见 @Li');
    const suggestions = page.getByRole('listbox', { name: '选择要提及的成员' });
    await expect(suggestions.getByRole('option', { name: /Lin/ })).toBeVisible();
    await suggestions.getByRole('option', { name: /Lin/ }).click();
    await expect(reply).toHaveValue('基准数据见 @Lin ');
    await reply.press('Control+Enter');
    await expect(section).toContainText('基准数据见 @Lin');
    expect(replyPayloads).toEqual([{
      body: '基准数据见 @Lin', parentId: 'comment-1', mentionedUserIds: ['member-2'],
    }]);
    expect((await new AxeBuilder({ page }).include('[data-testid="comment-section"]').analyze()).violations).toEqual([]);
  });

  test('empty state widens time scope and failed requests can be retried', async ({ page }) => {
    let mode: 'empty' | 'error' | 'success' = 'empty';
    await page.route('**/api/radar?*', route => mode === 'error'
      ? route.fulfill({ status: 503, json: { message: '测试来源暂时不可用' } })
      : route.fulfill({ json: { page: 1, perPage: 20, total: mode === 'empty' ? 0 : 1, totalPages: 1, items: mode === 'empty' ? [] : [candidate] } }));
    await page.goto('/radar');
    await expect(page.getByRole('heading', { name: '当前筛选没有内容' })).toBeVisible();
    await page.getByRole('button', { name: '查看全部时间' }).click();
    await expect.poll(() => new URL(page.url()).searchParams.get('date')).toBe('all');
    mode = 'error';
    await page.reload();
    await expect(page.getByRole('heading', { name: '加载失败', exact: true })).toBeVisible();
    await expect(page.getByText('测试来源暂时不可用')).toBeVisible();
    mode = 'success';
    await page.getByRole('button', { name: '重试', exact: true }).click();
    await expect(page.getByRole('link', { name: candidate.title, exact: true })).toBeVisible();
  });

  test('source group navigation and pagination preserve URL state', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.route('**/api/radar?*', route => {
      const params = new URL(route.request().url()).searchParams;
      const secondPage = params.get('page') === '2';
      return route.fulfill({ json: { page: secondPage ? 2 : 1, perPage: 20, total: 21, totalPages: 2, items: [{ ...candidate, title: secondPage ? '第二页内容' : candidate.title }] } });
    });
    await page.goto('/radar?date=all');
    await page.getByRole('button', { name: '下一页', exact: true }).click();
    await expect.poll(() => new URL(page.url()).searchParams.get('page')).toBe('2');
    await expect(page.getByRole('link', { name: '第二页内容', exact: true })).toBeVisible();
    await page.getByRole('button', { name: '按来源浏览', exact: true }).click();
    await expect.poll(() => new URL(page.url()).searchParams.get('view')).toBe('source');
    await page.getByRole('button', { name: '查看全部GitHub 更新', exact: true }).click();
    await expect.poll(() => new URL(page.url()).searchParams.get('view')).toBe('ranked');
    const state = new URL(page.url()).searchParams;
    expect(state.get('source')).toBe('github');
    expect(state.get('page')).toBe('1');
    expect(state.get('date')).toBe('all');
  });

  test('favorite toggles through the existing POST and DELETE contracts', async ({ page }) => {
    const methods: string[] = [];
    await page.route('**/api/radar-feedback*', route => {
      const method = route.request().method();
      methods.push(method);
      return route.fulfill({ json: { feedbackCounts: { ...candidate.feedbackCounts, favorite: method === 'POST' ? 1 : 0 } } });
    });
    await page.goto('/radar?date=all');
    await page.getByRole('button', { name: '收藏（0）', exact: true }).click();
    const selected = page.getByRole('button', { name: '收藏（1）', exact: true });
    await expect(selected).toHaveAttribute('aria-pressed', 'true');
    await selected.click();
    await expect(page.getByRole('button', { name: '收藏（0）', exact: true })).toHaveAttribute('aria-pressed', 'false');
    expect(methods).toEqual(['POST', 'DELETE']);
  });

  test('share dialog focuses its native input, preserves errors, and submits unchanged data', async ({ page }) => {
    const payloads: unknown[] = [];
    let fail = true;
    await page.route('**/api/shares', route => {
      if (route.request().method() === 'GET') return route.fulfill({ json: { items: [] } });
      payloads.push(route.request().postDataJSON());
      return route.fulfill({ status: fail ? 503 : 200, json: fail ? { message: '测试提交失败' } : { id } });
    });
    await page.goto('/radar?date=all');
    const trigger = page.getByRole('button', { name: '分享链接', exact: true });
    await trigger.click();
    const dialog = page.getByRole('dialog', { name: '分享技术链接' });
    const input = dialog.getByRole('textbox', { name: '分享 URL', exact: true });
    await expect(input).toBeFocused();
    await expect(dialog.getByRole('button', { name: '提交审核' })).toBeDisabled();
    await input.fill('https://example.com/share');
    await dialog.getByRole('textbox', { name: '分享说明', exact: true }).fill('值得关注');
    await dialog.getByRole('button', { name: '提交审核' }).click();
    await expect(dialog.getByRole('alert')).toContainText('测试提交失败');
    await expect(input).toHaveValue('https://example.com/share');
    fail = false;
    await dialog.getByRole('button', { name: '提交审核' }).click();
    await expect(dialog.getByRole('status')).toContainText('已提交');
    await expect(input).toHaveValue('');
    expect(payloads).toEqual([
      { url: 'https://example.com/share', userNote: '值得关注' },
      { url: 'https://example.com/share', userNote: '值得关注' },
    ]);
    expect((await new AxeBuilder({ page }).include('.MuiDialog-root').analyze()).violations).toEqual([]);
    await page.keyboard.press('Escape');
    await expect(trigger).toBeFocused();
  });

  for (const width of [1440, 390]) {
    test(`source confirmation preserves the ${width}px preview and its radar identity`, async ({ page }) => {
      await page.context().route('https://example.com/research**', route => route.fulfill({
        contentType: 'text/html', body: '<main><h1>Original article fixture</h1></main>',
      }));
      await page.setViewportSize({ width, height: 844 });
      await page.goto('/radar?date=all');
      const title = page.getByRole('link', { name: candidate.title, exact: true });
      await title.click();
      const preview = page.getByRole(width >= 1024 ? 'complementary' : 'dialog', { name: '文章概览', exact: true }).filter({ visible: true });
      const open = preview.getByRole('link', { name: '打开原文', exact: true });
      await expect(open).toHaveAttribute('href', 'https://example.com/research');
      const sourcePromise = page.waitForEvent('popup');
      await open.click();
      const sourcePage = await sourcePromise;
      await expect(sourcePage).toHaveURL(/https:\/\/example\.com\/research$/u);
      await expect(sourcePage.getByRole('heading', { name: 'Original article fixture' })).toBeVisible();
      await sourcePage.close();
    });
  }

  for (const width of [1440, 320]) {
    test(`${width}px: the Reader prompt is only shown on an explicit install request`, async ({ page }, testInfo) => {
      const storeUrl = 'https://chromewebstore.google.com/detail/bldpmkepljipbadeegednfinnilgoedl';
      await page.context().route(storeUrl, route => route.fulfill({ contentType: 'text/html', body: '<h1>Reader store fixture</h1>' }));
      await page.context().route('https://example.com/research**', route => route.fulfill({ contentType: 'text/html', body: '<h1>Original article fixture</h1>' }));
      await page.setViewportSize({ width, height: 844 });
      await page.goto(`/radar/${id}`);
      const platformUrl = page.url();
      // 打开原文是直链，不弹安装对话框。
      const sourcePromise = page.waitForEvent('popup');
      await page.getByRole('link', { name: '打开原文', exact: true }).click();
      const sourcePage = await sourcePromise;
      await expect(sourcePage).toHaveURL(/https:\/\/example\.com\/research$/u);
      await sourcePage.close();
      await expect(page.getByRole('dialog', { name: '是否已安装 Reader？' })).toHaveCount(0);
      await expect(page).toHaveURL(platformUrl);

      // 显式请求 Reader 时才给安装说明。
      await page.getByRole('button', { name: '安装 Reader', exact: true }).click();
      const prompt = page.getByRole('dialog', { name: '是否已安装 Reader？' });
      await expect(prompt).toBeVisible();
      const storePromise = page.waitForEvent('popup');
      await prompt.getByRole('link', { name: '未安装，前往商店' }).click();
      const store = await storePromise;
      await expect(store).toHaveURL(storeUrl);
      await expect(page).toHaveURL(platformUrl);
      await expect(prompt.getByRole('link', { name: '安装完成，打开原文' })).toBeVisible();
      await expect(prompt.locator('..')).toHaveCSS('opacity', '1');
      expect(await prompt.locator('[data-reader-launch-source]').count()).toBe(1);
      expect(await prompt.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
      await page.screenshot({ path: testInfo.outputPath(`reader-install-return-${width}.png`) });
      await store.close();
      const readerSourcePromise = page.waitForEvent('popup');
      await prompt.getByRole('link', { name: '安装完成，打开原文' }).click();
      const readerSourcePage = await readerSourcePromise;
      await expect(readerSourcePage.getByRole('heading', { name: 'Original article fixture' })).toBeVisible();
      expect(new URL(readerSourcePage.url()).searchParams.get('deep-research-summary')).toBe(id);
      await expect(page).toHaveURL(platformUrl);
    });
  }

  for (const theme of ['light', 'dark'] as const) {
    test(`${theme}: cold load, no overflow at migration breakpoints, and no axe exemptions`, async ({ page }) => {
      const errors: string[] = [];
      page.on('pageerror', error => errors.push(`${page.viewportSize()?.width}: ${error.message}\n${error.stack ?? ''}`));
      page.on('console', message => {
        if (message.type() === 'error' && /hydration|did not match/i.test(message.text())) {
          errors.push(`${page.viewportSize()?.width}: ${message.text()}`);
        }
      });
      await page.addInitScript(mode => localStorage.setItem('dr-theme', mode), theme);
      for (const width of [1440, 1024, 768, 390, 320]) {
        await page.setViewportSize({ width, height: 900 });
        await page.goto('/radar?date=all');
        await expect(page.getByRole('link', { name: candidate.title, exact: true })).toBeVisible();
        await expect.poll(() => page.locator('html').getAttribute('class')).toContain(theme);
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
      }
      const results = await new AxeBuilder({ page }).include('.material-surface').analyze();
      expect(results.violations).toEqual([]);
      expect(errors).toEqual([]);
    });
  }
});
