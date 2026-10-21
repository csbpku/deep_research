import { test, expect, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { isolatedMuiOrigin, loginMuiFixture } from './mui-local-fixtures';

const firstTitle = 'AI 编码代理与检索增强——跨团队验证的持续研究脉络';
const screen = (page: Page) => page.locator('[data-topics-screen]');
const filters = (page: Page) => page.getByRole('navigation', { name: '专题筛选', exact: true });

test.describe('MUI topics: real RSC/database and password sessions', () => {
  test.skip(process.env.MUI_ISOLATED_BROWSER !== '1', 'Requires a separately seeded local database, never the ordinary development server');
  test.beforeEach(() => { isolatedMuiOrigin(); });

  test('anonymous followed view is empty, invalid filter agrees with server fallback, native links preserve navigation', async ({ page }) => {
    await page.goto('/topics?filter=followed');
    await expect(screen(page).getByRole('heading', { name: '登录后查看已关注专题', exact: true })).toBeVisible();
    await expect(filters(page).getByRole('link', { name: '只看已关注', exact: true })).toHaveAttribute('aria-current', 'page');
    await expect(screen(page).getByRole('article')).toHaveCount(0);
    await filters(page).getByRole('link', { name: '全部专题', exact: true }).click();
    await expect(screen(page).getByRole('article')).toHaveCount(6);
    await expect(screen(page).getByText('不应公开的停用专题')).toHaveCount(0);
    await expect(screen(page).getByRole('link', { name: firstTitle, exact: true })).toHaveAttribute('href', '/topics/mui-topic-1');
    await page.goto('/topics?filter=invalid');
    await expect(filters(page).getByRole('link', { name: '全部专题', exact: true })).toHaveAttribute('aria-current', 'page');
    await expect(screen(page).getByRole('article')).toHaveCount(6);
    await expect(screen(page).getByRole('link', { name: '登录后查看我的专题', exact: true })).toHaveAttribute('href', '/me/topics');
    await page.goto('/me');
    await expect(page).toHaveURL(/\/signin\?callbackUrl=\/me$/);
  });

  test('member follows and unread counts survive filters, reload and browser back without exposing another member’s follow', async ({ page, context }) => {
    await loginMuiFixture(context.request);
    await page.goto('/topics?filter=followed');
    await expect(screen(page).getByRole('article')).toHaveCount(2);
    await expect(screen(page).getByRole('heading', { name: firstTitle, exact: true })).toBeVisible();
    await expect(screen(page).getByRole('heading', { name: 'MUI 专题 3', exact: true })).toBeVisible();
    await expect(screen(page).getByRole('heading', { name: 'MUI 专题 5', exact: true })).toHaveCount(0);
    await expect(screen(page).getByText('1 个新议题', { exact: true })).toHaveCount(2);
    await expect(filters(page).getByLabel('2 个新议题', { exact: true })).toBeVisible();
    await filters(page).getByRole('link', { name: '热门', exact: true }).click();
    await expect(page).toHaveURL(/filter=hot$/);
    await expect(screen(page).getByRole('article')).toHaveCount(2);
    await expect(screen(page).getByText('2 个活跃议题', { exact: true })).toBeVisible();
    await page.reload();
    await expect(filters(page).getByRole('link', { name: '热门', exact: true })).toHaveAttribute('aria-current', 'page');
    await page.goBack();
    await expect(filters(page).getByRole('link', { name: /只看已关注/ })).toHaveAttribute('aria-current', 'page');
    await filters(page).getByRole('link', { name: '升温', exact: true }).click();
    await expect(screen(page).getByRole('article')).toHaveCount(2);
    await expect(screen(page).getByRole('heading', { name: 'MUI 专题 3', exact: true })).toBeVisible();
    await filters(page).getByRole('link', { name: '新出现', exact: true }).click();
    await expect(screen(page).getByRole('article')).toHaveCount(2);
    await expect(screen(page).getByText('已关注', { exact: true })).toHaveCount(0);
    await expect(screen(page).getByText('待同步', { exact: true })).toBeVisible();
  });

  for (const authenticated of [false, true]) {
    test(`${authenticated ? 'member' : 'anonymous'}: clearing every server filter commits the canonical URL without a document reload`, async ({ page, context }) => {
      if (authenticated) await loginMuiFixture(context.request);
      const errors: string[] = [];
      page.on('pageerror', error => errors.push(error.message));
      for (const filter of ['hot', 'warming', 'emerging', 'followed']) {
        await page.goto(`/topics?filter=${filter}`);
        await expect(filters(page).getByRole('link', { name: '全部专题', exact: true })).toHaveAttribute('href', '/topics');
        await page.evaluate(() => { document.documentElement.dataset.muiNavigationIdentity = 'retained'; });
        await filters(page).getByRole('link', { name: '全部专题', exact: true }).click();
        await expect(page).toHaveURL(`${isolatedMuiOrigin()}/topics`);
        await expect(screen(page).getByRole('article')).toHaveCount(6);
        await expect(page.locator('html')).toHaveAttribute('data-mui-navigation-identity', 'retained');
        await expect(filters(page).getByRole('link', { name: '全部专题', exact: true })).toHaveAttribute('aria-current', 'page');
        await page.goBack();
        await expect(page).toHaveURL(`${isolatedMuiOrigin()}/topics?filter=${filter}`);
        await expect(screen(page).getByRole('article')).toHaveCount(filter === 'followed' && !authenticated ? 0 : 2);
        await expect(filters(page).locator('[aria-current="page"]')).toHaveAttribute('href', `/topics?filter=${filter}`);
        if (filter === 'followed' && !authenticated) {
          // Zero articles also matches a still-pending route. Verify the actual
          // restored empty view before issuing the next history navigation.
          await expect(screen(page).getByRole('heading', { name: '登录后查看已关注专题', exact: true })).toBeVisible();
        }
        await page.goForward();
        await expect(page).toHaveURL(`${isolatedMuiOrigin()}/topics`);
        await expect(screen(page).getByRole('article')).toHaveCount(6);
      }
      expect(errors).toEqual([]);
    });
  }

  test('rapid history changes leave content matching the final canonical URL', async ({ page }) => {
    await page.goto('/topics?filter=followed');
    await filters(page).getByRole('link', { name: '全部专题', exact: true }).click();
    await expect(screen(page).getByRole('article')).toHaveCount(6);
    for (let iteration = 0; iteration < 5; iteration++) {
      await page.goBack();
      await expect(page).toHaveURL(`${isolatedMuiOrigin()}/topics?filter=followed`);
      // Deliberately do not wait for the intermediate empty view to settle.
      await page.goForward();
      await expect(page).toHaveURL(`${isolatedMuiOrigin()}/topics`);
      await page.waitForLoadState('networkidle');
      await expect(filters(page).getByRole('link', { name: '全部专题', exact: true })).toHaveAttribute('aria-current', 'page');
      await expect(screen(page).getByRole('article')).toHaveCount(6);
    }
  });

  test('slow filter navigation exposes router-owned pending status without shifting or blocking the link', async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.goto('/topics');
    await expect(screen(page).getByRole('article')).toHaveCount(6);
    let release!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; });
    let blocked = false;
    await page.route('**/topics?*', async route => {
      const request = route.request();
      if (new URL(request.url()).searchParams.get('filter') === 'hot' && request.headers().rsc && !request.headers()['next-router-prefetch']) {
        blocked = true;
        await held;
      }
      await route.continue();
    });
    const link = filters(page).locator('a[href="/topics?filter=hot"]');
    const before = await link.boundingBox();
    try {
      await link.click();
      await expect.poll(() => blocked).toBe(true);
      const pending = filters(page).getByRole('status', { name: '正在加载热门', exact: true });
      await expect(pending).toBeVisible();
      await expect(pending.locator('svg')).toHaveCSS('animation-name', 'none');
      await expect(link).not.toHaveAttribute('aria-disabled', 'true');
      const after = await link.boundingBox();
      expect(after?.width).toBe(before?.width);
      expect(after?.height).toBe(before?.height);
      expect((await new AxeBuilder({ page }).include('[data-topics-screen]').analyze()).violations).toEqual([]);
    } finally { release(); }
    await expect(page).toHaveURL(/filter=hot$/);
    await expect(screen(page).getByRole('article')).toHaveCount(2);
    await expect(filters(page).getByRole('status')).toHaveCount(0);
  });

  for (const theme of ['light', 'dark'] as const) {
    test(`${theme}: authenticated topic content is server-rendered before scripts and hydrates without replacement`, async ({ page, context }) => {
      await loginMuiFixture(context.request);
      await page.addInitScript(mode => localStorage.setItem('dr-theme', mode), theme);
      const errors: string[] = [];
      page.on('pageerror', error => errors.push(error.message));
      let release!: () => void;
      const ready = new Promise<void>(resolve => { release = resolve; });
      let held = 0;
      await page.route('**/_next/static/**/*.js', async route => {
        held++;
        await ready;
        await route.continue();
      });
      try {
        await page.goto('/topics?filter=followed', { waitUntil: 'commit' });
        await expect(screen(page).getByRole('heading', { name: firstTitle, exact: true })).toBeVisible();
        await expect(screen(page).getByRole('article')).toHaveCount(2);
        await expect.poll(() => held).toBeGreaterThan(0);
        await expect(screen(page).getByRole('article').first().getByRole('heading')).toHaveCSS('font-size', '16px');
      } finally { release(); }
      // SSR buttons exist before event listeners. Finish the deliberately held
      // bundle loads before testing a single, unretried interactive click.
      await page.waitForLoadState('networkidle');
      await expect(page.locator('html')).toHaveClass(new RegExp(theme));
      const trigger = page.getByRole('button', { name: '打开用户菜单' });
      await trigger.click();
      await expect(page.getByRole('menuitem', { name: '个人设置', exact: true })).toBeVisible();
      await page.keyboard.press('Escape');
      await expect(trigger).toBeFocused();
      expect(errors).toEqual([]);
    });

    test(`${theme}: repeated authenticated cold navigations preserve the route slot and theme`, async ({ page, context }) => {
      test.setTimeout(60_000);
      await loginMuiFixture(context.request);
      await page.addInitScript(mode => localStorage.setItem('dr-theme', mode), theme);
      const errors: string[] = [];
      page.on('pageerror', error => errors.push(error.message));
      page.on('console', message => { if (message.type() === 'error' && /hydration|did not match/i.test(message.text())) errors.push(message.text()); });
      for (let iteration = 0; iteration < 3; iteration++) {
        for (const width of [1440, 1024, 768, 390, 320]) {
          await page.setViewportSize({ width, height: 900 });
          await page.goto(iteration % 2 ? '/topics?filter=followed' : '/topics');
          await expect(screen(page).getByRole('article')).toHaveCount(iteration % 2 ? 2 : 6);
          await expect(page.locator('html')).toHaveClass(new RegExp(theme));
          const trigger = page.getByRole('button', { name: '打开用户菜单' });
          await trigger.click();
          await expect(page.getByRole('menuitem', { name: '我的草稿', exact: true })).toBeVisible();
          await page.keyboard.press('Escape');
          await expect(trigger).toBeFocused();
        }
      }
      expect(errors).toEqual([]);
    });

    test(`${theme}: shared hierarchy, real content, five widths, native keyboard links and axe without exclusions`, async ({ page, context }, testInfo) => {
      await loginMuiFixture(context.request);
      await page.addInitScript(mode => localStorage.setItem('dr-theme', mode), theme);
      const errors: string[] = [];
      page.on('pageerror', error => errors.push(error.message));
      for (const width of [1440, 1024, 768, 390, 320]) {
        await page.setViewportSize({ width, height: 1000 });
        await page.goto('/topics');
        await expect(screen(page).getByRole('article')).toHaveCount(6);
        const first = screen(page).getByRole('article').first();
        await expect(first.getByRole('heading', { level: 2 })).toHaveCSS('font-size', '16px');
        await expect(first.locator('p').first()).toHaveCSS('font-size', '14px');
        await expect(first.locator('time')).toHaveCSS('font-size', '12px');
        const columns = await screen(page).getByRole('list', { name: '专题列表' }).evaluate(element => getComputedStyle(element).gridTemplateColumns.split(' ').length);
        expect(columns).toBe(width >= 1280 ? 3 : width >= 640 ? 2 : 1);
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
        expect((await new AxeBuilder({ page }).include('[data-topics-screen]').analyze()).violations).toEqual([]);
        await page.screenshot({ path: testInfo.outputPath(`topics-${theme}-${width}.png`), fullPage: true });
      }
      const hot = filters(page).getByRole('link', { name: '热门', exact: true });
      await hot.focus();
      await expect(hot).toHaveCSS('outline-style', 'solid');
      await page.keyboard.press('Enter');
      await expect(page).toHaveURL(/filter=hot$/);
      await expect(hot).toHaveAttribute('aria-current', 'page');
      expect(errors).toEqual([]);
    });
  }

  test('coarse pointer targets and reduced-motion / 200% layout proxy remain operable', async ({ browser }) => {
    const context = await browser.newContext({ hasTouch: true, viewport: { width: 768, height: 1000 }, reducedMotion: 'reduce' });
    try {
      await loginMuiFixture(context.request);
      const page = await context.newPage();
      await page.goto(`${isolatedMuiOrigin()}/topics`);
      for (const link of await filters(page).getByRole('link').all()) {
        expect((await link.boundingBox())!.height).toBeGreaterThanOrEqual(44);
      }
      await page.evaluate(() => { document.documentElement.style.zoom = '2'; });
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      await expect(screen(page).getByRole('link', { name: firstTitle, exact: true })).toBeVisible();
      await filters(page).getByRole('link', { name: '升温', exact: true }).click();
      await expect(screen(page).getByRole('article')).toHaveCount(2);
    } finally { await context.close(); }
  });

  test('real member, admin, disabled and other-member sessions retain shell authorization boundaries', async ({ browser }) => {
    for (const theme of ['light', 'dark'] as const) {
    for (const identity of ['member', 'admin', 'other', 'disabled'] as const) {
      const context = await browser.newContext();
      try {
        await context.addInitScript(mode => localStorage.setItem('dr-theme', mode), theme);
        await loginMuiFixture(context.request, identity);
        const page = await context.newPage();
        await page.goto(`${isolatedMuiOrigin()}/topics?filter=followed`);
        if (identity === 'disabled') {
          await expect(page.getByRole('button', { name: '打开用户菜单', exact: true })).toHaveCount(0);
          await expect(screen(page).getByRole('article')).toHaveCount(0);
          continue;
        }
        await expect(screen(page).getByRole('article')).toHaveCount(identity === 'member' ? 2 : identity === 'other' ? 1 : 0);
        const trigger = page.getByRole('button', { name: '打开用户菜单', exact: true });
        await trigger.click();
        await expect(page.getByRole('menuitem', { name: 'Admin 控制台', exact: true })).toHaveCount(identity === 'admin' ? 1 : 0);
        // Measure composed colors after Grow has entered, not its translucent frames.
        await expect(page.locator('.MuiMenu-paper')).toHaveCSS('opacity', '1');
        await expect(page.locator('.MuiMenu-paper')).toHaveCSS('transform', 'none');
        expect((await new AxeBuilder({ page }).include('.MuiMenu-root').analyze()).violations).toEqual([]);
        await page.keyboard.press('Escape');
        await expect(trigger).toBeFocused();
        if (identity !== 'admin') {
          const response = await context.request.get(`${isolatedMuiOrigin()}/api/admin/dashboard`);
          expect(response.status()).toBe(403);
        }
      } finally { await context.close(); }
    }
    }
  });
});
