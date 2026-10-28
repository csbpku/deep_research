import { test, expect, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';

const id = '10000000-0000-4000-8000-000000000031';
const item = {
  id, type: 'research', status: 'published', title: '研究报告：证据与结论分离',
  body: '## 研究正文\n\n保留真实研究库的摘要、作者、状态和标签。', tags: ['评估', '长标签-'.repeat(16)],
  authorId: 'fixture-author', creationMethod: 'ai_research', aiAssisted: false,
  publishedAt: '2026-10-19T00:00:00Z', featuredAt: '2026-10-19T00:00:00Z',
  createdAt: '2026-10-18T00:00:00Z', updatedAt: '2026-10-18T00:00:00Z',
  author: { id: 'fixture-author', name: '回归测试作者' }, canEdit: false,
};
const knowledge = { ...item, id: `${id}-knowledge`, title: '知识卡片：RAG 检索', type: 'knowledge', tags: ['RAG'], creationMethod: 'manual', featuredAt: null, updatedAt: '2026-10-19T00:00:00Z', publishedAt: '2026-10-18T00:00:00Z' };
const draft = { ...item, status: 'draft', publishedAt: null, featuredAt: null, canEdit: true, title: '待编辑草稿' };

async function fixture(page: Page) {
  // Abort any unexpected mutation; action tests install more specific mock routes.
  await page.route('**/api/**', route => ['GET', 'HEAD'].includes(route.request().method()) ? route.continue() : route.abort('blockedbyclient'));
  await page.route('**/api/auth/session', route => route.fulfill({ json: { user: null } }));
  await page.route('**/api/researches?*', route => {
    const params = new URL(route.request().url()).searchParams;
    const scope = params.get('scope'), type = params.get('type'), second = params.get('page') === '2';
    const query = params.get('q')?.trim().toLowerCase() ?? '';
    const sort = params.get('sort') ?? 'newest';
    let items = scope === 'draft' ? [draft] : scope === 'mine'
      ? [{ ...item, title: '已归档研究', status: 'archived', canEdit: true }, { ...knowledge, canEdit: true }]
      : second ? [{ ...item, title: '第二页研究' }] : [item, knowledge];
    if (type) items = items.filter(row => row.type === type);
    if (query) items = items.filter(row =>
      row.title.toLowerCase().includes(query)
      || row.body.toLowerCase().includes(query)
      || row.tags.some(tag => tag.toLowerCase().includes(query)));
    if (sort === 'title') items = [...items].sort((a, b) => a.title.localeCompare(b.title, 'zh-Hans'));
    if (sort === 'updated') items = [...items].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    const paginated = scope === 'published' && !type;
    // total 是筛选后的全库命中数：只有未筛选的 published 才假装有两页。
    const total = paginated && !query ? 21 : items.length;
    return route.fulfill({ json: { items, page: second ? 2 : 1, limit: 20, total, totalPages: total > 20 ? 2 : 1 } });
  });
}

test.describe('MUI research library (mock API; no database writes)', () => {
  test.beforeEach(async ({ page }) => { await fixture(page); });

  for (const theme of ['light', 'dark'] as const) {
    test(`${theme}: real library layout reflows long tags and retains content`, async ({ page }, testInfo) => {
      const errors: string[] = [];
      page.on('pageerror', error => errors.push(error.message));
      await page.addInitScript(mode => localStorage.setItem('dr-theme', mode), theme);
      for (const width of [1440, 1024, 768, 390, 320]) {
        await page.setViewportSize({ width, height: 900 });
        await page.goto('/researches');
        await expect(page.getByRole('heading', { name: '研究库', exact: true })).toBeVisible();
        await expect(page.getByRole('heading', { name: item.title, exact: true })).toBeVisible();
        await expect(page.getByRole('heading', { name: knowledge.title, exact: true })).toBeVisible();
        await expect(page.getByRole('link', { name: /研究报告：证据与结论分离/ })).toHaveAttribute('href', `/researches/${id}`);
        await expect(page.locator('html')).toHaveClass(new RegExp(theme));
        expect(await page.getByRole('heading', { name: '研究库', exact: true }).evaluate(element => getComputedStyle(element).fontSize)).toBe(width < 640 ? '20px' : '24px');
        expect(await page.getByRole('article').first().evaluate(element => ({
          padding: getComputedStyle(element).padding,
          title: getComputedStyle(element.querySelector('h2')!).fontSize,
          body: getComputedStyle(element.querySelector('p')!).fontSize,
        }))).toEqual({ padding: '16px', title: '16px', body: '14px' });
        expect(await page.getByRole('main').locator('.material-surface').first().evaluate(element => getComputedStyle(element).maxWidth)).toBe('1280px');
        expect((await new AxeBuilder({ page }).include('#main-content').analyze()).violations).toEqual([]);
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
        if (width === 1440 || width === 390) await page.screenshot({ path: testInfo.outputPath(`library-${theme}-${width}.png`), fullPage: true });
      }
      expect(errors).toEqual([]);
    });

    test(`${theme}: destructive dialogs keep safe focus, readable errors and an escape route`, async ({ page }) => {
      await page.addInitScript(mode => localStorage.setItem('dr-theme', mode), theme);
      await page.route('**/api/researches/*/archive', route => route.fulfill({ status: 503, json: { message: '测试归档失败' } }));
      await page.goto('/researches?tab=mine');
      const trigger = page.getByRole('button', { name: `归档：${knowledge.title}`, exact: true });
      await trigger.click();
      const dialog = page.getByRole('dialog', { name: '归档这份调研？' });
      await expect(dialog.getByRole('button', { name: '取消', exact: true })).toBeFocused();
      await dialog.getByRole('button', { name: '确认归档' }).click();
      await expect(dialog.getByRole('alert')).toHaveText('测试归档失败');
      expect((await new AxeBuilder({ page }).include('.MuiDialog-root').analyze()).violations).toEqual([]);
      for (let i = 0; i < 5; i++) {
        await page.keyboard.press('Tab');
        await expect.poll(() => dialog.evaluate(element => element.contains(document.activeElement))).toBe(true);
      }
      await page.keyboard.press('Escape');
      await expect(dialog).not.toBeVisible();
      await expect(trigger).toBeFocused();
    });
  }

  test('search and sorting are delegated to the server', async ({ page }) => {
    const requests: URL[] = [];
    page.on('request', request => { if (request.url().includes('/api/researches?')) requests.push(new URL(request.url())); });
    await page.goto('/researches');
    await expect(page.getByRole('heading', { name: item.title, exact: true })).toBeVisible();
    const initialRequests = requests.length;
    const input = page.getByRole('searchbox', { name: '搜索研究库' });
    await input.fill('RAG');
    await expect(page.getByRole('heading', { name: knowledge.title, exact: true })).toBeVisible();
    await expect(page.getByRole('heading', { name: item.title, exact: true })).not.toBeVisible();
    await input.fill('不存在的标题');
    await expect(page.getByRole('heading', { name: '没有匹配项' })).toBeVisible();
    // 搜索必须打到服务端：客户端只能过滤当前页，第 21 条之后会变成假象。
    expect(requests.some(url => url.searchParams.get('q') === 'RAG')).toBe(true);
    await input.fill('');
    await page.getByRole('combobox', { name: '排序方式' }).click();
    await page.getByRole('option', { name: '最近编辑', exact: true }).click();
    await expect(page.getByRole('tabpanel').getByRole('heading', { level: 2 }).first()).toHaveText(knowledge.title);
    expect(requests.some(url => url.searchParams.get('sort') === 'updated')).toBe(true);
    expect(requests.length).toBeGreaterThan(initialRequests);
  });

  test('type API parameters, legacy URLs, tabs and pagination preserve existing contracts', async ({ page }) => {
    await page.goto('/researches?tab=knowledge');
    await expect(page.getByRole('tab', { name: '成果', exact: true })).toHaveAttribute('aria-selected', 'true');
    await expect(page.getByRole('combobox', { name: '内容类型' })).toHaveText('知识卡片');
    await expect(page.getByRole('heading', { name: knowledge.title, exact: true })).toBeVisible();
    await page.getByRole('combobox', { name: '内容类型' }).click();
    await page.getByRole('option', { name: '全部类型', exact: true }).click();
    await expect(page.getByRole('heading', { name: item.title, exact: true })).toBeVisible();
    await page.getByRole('button', { name: '下一页', exact: true }).click();
    await expect(page.getByRole('heading', { name: '第二页研究' })).toBeVisible();
    const draftTab = page.getByRole('tab', { name: '草稿', exact: true });
    await draftTab.click();
    await expect(page).toHaveURL(/tab=draft/);
    await expect(page.getByRole('heading', { name: draft.title, exact: true })).toBeVisible();
    await page.reload();
    await expect(draftTab).toHaveAttribute('aria-selected', 'true');
    await draftTab.focus();
    await page.keyboard.press('ArrowRight');
    await expect(page).toHaveURL(/tab=mine/);
    await expect(page.getByRole('tab', { name: '我的已发布', exact: true })).toHaveAttribute('aria-selected', 'true');
    await expect(page.getByRole('heading', { name: '已归档研究' })).toBeVisible();
  });

  test('add menu preserves native destinations and restores focus', async ({ page }) => {
    await page.goto('/researches');
    await expect(page.getByRole('link', { name: '开始 AI 调研', exact: true })).toHaveAttribute('href', '/ai-research');
    const trigger = page.getByRole('button', { name: '添加内容', exact: true });
    await trigger.click();
    await expect(page.getByRole('menuitem', { name: '空白草稿' })).toHaveAttribute('href', '/researches/new?mode=blank');
    await expect(page.getByRole('menuitem', { name: '导入文件' })).toHaveAttribute('href', '/researches/import');
    await page.keyboard.press('Escape');
    await expect(trigger).toBeFocused();
  });

  test('draft delete is confirmed, pending is guarded, errors survive and retry invalidates the list', async ({ page }) => {
    let complete!: () => void;
    const pending = new Promise<void>(resolve => { complete = resolve; });
    let calls = 0;
    await page.route(`**/api/researches/${id}`, async route => {
      expect(route.request().method()).toBe('DELETE');
      calls++;
      if (calls === 1) { await pending; return route.fulfill({ status: 503, json: { message: '测试删除失败' } }); }
      await page.route('**/api/researches?*', next => next.fulfill({ json: { items: [], page: 1, limit: 20, total: 0, totalPages: 1 } }));
      return route.fulfill({ json: { ok: true } });
    });
    await page.goto('/researches?tab=draft');
    const trigger = page.getByRole('button', { name: `打开草稿操作：${draft.title}` });
    await trigger.click();
    await expect(page.getByRole('menuitem', { name: '编辑草稿' })).toHaveAttribute('href', `/researches/${id}/edit`);
    await page.getByRole('menuitem', { name: '删除草稿', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: '永久删除这份草稿？' });
    await expect(dialog).toContainText(draft.title);
    await expect(dialog.getByRole('button', { name: '取消', exact: true })).toBeFocused();
    await page.keyboard.press('Escape');
    await expect(dialog).not.toBeVisible();
    await expect(trigger).toBeFocused();
    expect(calls).toBe(0);
    await trigger.click();
    await page.getByRole('menuitem', { name: '删除草稿', exact: true }).click();
    await dialog.getByRole('button', { name: '永久删除', exact: true }).click();
    await expect(dialog.getByRole('button', { name: '删除中…' })).toBeDisabled();
    await page.keyboard.press('Escape');
    await expect(dialog).toBeVisible();
    complete();
    await expect(dialog.getByRole('alert')).toHaveText('测试删除失败');
    await expect.poll(() => dialog.evaluate(element => getComputedStyle(element.parentElement!).opacity)).toBe('1');
    expect((await new AxeBuilder({ page }).include('.MuiDialog-root').analyze()).violations).toEqual([]);
    await dialog.getByRole('button', { name: '永久删除', exact: true }).click();
    await expect(dialog).not.toBeVisible();
    await expect(page.getByRole('heading', { name: '暂无草稿' })).toBeVisible();
    expect(calls).toBe(2);
  });

  test('archive and restore use unchanged POST endpoints and keep errors inline', async ({ page }) => {
    const requests: string[] = [];
    let fail = true;
    let rereading = false;
    let releaseReread!: () => void;
    const rereadReady = new Promise<void>(resolve => { releaseReread = resolve; });
    await page.route('**/api/researches?*', async route => {
      if (!fail) { rereading = true; await rereadReady; }
      return route.fallback();
    });
    await page.route('**/api/researches/*/archive', route => {
      requests.push(`${route.request().method()} archive`);
      return route.fulfill({ status: fail ? 503 : 200, json: fail ? { message: '测试归档失败' } : { ok: true } });
    });
    await page.route('**/api/researches/*/restore', route => {
      requests.push(`${route.request().method()} restore`);
      return route.fulfill({ json: { ok: true } });
    });
    await page.goto('/researches?tab=mine');
    const archive = page.getByRole('button', { name: `归档：${knowledge.title}`, exact: true });
    await archive.click();
    const dialog = page.getByRole('dialog', { name: '归档这份调研？' });
    await expect(dialog.getByRole('button', { name: '取消', exact: true })).toBeFocused();
    await dialog.getByRole('button', { name: '确认归档', exact: true }).click();
    await expect(dialog.getByRole('alert')).toHaveText('测试归档失败');
    fail = false;
    await dialog.getByRole('button', { name: '确认归档', exact: true }).click();
    await expect.poll(() => rereading).toBe(true);
    await expect(dialog.getByRole('button', { name: '处理中…' })).toBeDisabled();
    await page.keyboard.press('Escape');
    await expect(dialog).toBeVisible();
    releaseReread();
    await expect(dialog).not.toBeVisible();
    await expect(archive).toBeFocused();
    await page.getByRole('button', { name: '恢复：已归档研究', exact: true }).click();
    await page.getByRole('dialog', { name: '恢复这份调研？' }).getByRole('button', { name: '确认恢复' }).click();
    await expect(page.getByRole('dialog')).not.toBeVisible();
    expect(requests).toEqual(['POST archive', 'POST archive', 'POST restore']);
  });

  test('loading, empty and failed reads retain recovery actions', async ({ page }) => {
    let mode: 'pending' | 'error' | 'empty' = 'pending';
    let release!: () => void;
    const responseReady = new Promise<void>(resolve => { release = resolve; });
    await page.route('**/api/researches?*', async route => {
      if (mode === 'pending') await responseReady;
      return mode === 'error' ? route.fulfill({ status: 503, json: {} })
        : route.fulfill({ json: { items: [], page: 1, limit: 20, total: 0, totalPages: 1 } });
    });
    await page.goto('/researches');
    await expect(page.getByText('正在加载研究库…', { exact: true })).toBeVisible();
    mode = 'error'; release();
    await expect(page.getByRole('tabpanel').getByRole('alert')).toContainText('研究库暂时无法加载');
    mode = 'empty';
    await page.getByRole('button', { name: '重试', exact: true }).click();
    await expect(page.getByRole('heading', { name: '暂无成果' })).toBeVisible();
  });

  test('touch controls keep shared 44px targets, including tabs and menu items', async ({ browser }) => {
    const context = await browser.newContext({ baseURL: process.env.E2E_BASE_URL, viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
    try {
      const page = await context.newPage();
      await fixture(page);
      await page.goto('/researches?tab=mine');
      await expect(page.getByRole('heading', { name: '已归档研究' })).toBeVisible();
      expect(await page.evaluate(() => matchMedia('(pointer: coarse)').matches)).toBe(true);
      for (const control of await page.getByRole('main').locator('button:not([disabled]), [role="combobox"]').all()) {
        const bounds = await control.boundingBox();
        const label = await control.getAttribute('aria-label') ?? await control.getAttribute('role') ?? await control.textContent();
        expect(bounds?.height, label ?? '').toBeGreaterThanOrEqual(44);
        expect(bounds?.width, label ?? '').toBeGreaterThanOrEqual(44);
      }
      await page.getByRole('button', { name: '添加内容', exact: true }).click();
      // Grow scales the menu while entering; measure the completed hit area.
      for (const option of await page.getByRole('menuitem').all()) {
        await expect.poll(async () => (await option.boundingBox())?.height).toBeGreaterThanOrEqual(44);
      }
    } finally { await context.close(); }
  });

  test('200% CSS zoom layout proxy preserves filters, cards and focus access', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.goto('/researches');
    await expect(page.getByRole('heading', { name: item.title, exact: true })).toBeVisible();
    // Layout proxy, not a claim to have tested every browser's native zoom UI.
    await page.evaluate(() => { document.body.style.zoom = '2'; });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    const input = page.getByRole('searchbox', { name: '搜索研究库' });
    await input.fill('RAG');
    await expect(page.getByRole('heading', { name: knowledge.title, exact: true })).toBeVisible();
    await page.getByRole('combobox', { name: '排序方式' }).focus();
    await page.keyboard.press('ArrowDown');
    await expect(page.getByRole('listbox')).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.getByRole('combobox', { name: '排序方式' })).toBeFocused();
    expect((await new AxeBuilder({ page }).include('#main-content').analyze()).violations).toEqual([]);
  });
});
