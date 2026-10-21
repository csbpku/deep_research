import { test, expect, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { isolatedMuiOrigin, loginMuiFixture } from './mui-local-fixtures';

// Streaming can temporarily park another route subtree outside <main>.
// Assert the active content, not Next's hidden transport markup.
const screen = (page: Page) => page.getByRole('main').locator('[data-my-topics-screen]');
const firstTitle = 'AI 编码代理与检索增强——跨团队验证的持续研究脉络';

test.describe('MUI My Topics: real database and password sessions', () => {
  test.skip(process.env.MUI_ISOLATED_BROWSER !== '1', 'Requires the isolated synthetic database');
  test.beforeEach(() => { isolatedMuiOrigin(); });

  test('anonymous and disabled sessions redirect before exposing personal follow data', async ({ browser }) => {
    for (const disabled of [false, true]) {
      const context = await browser.newContext();
      try {
        if (disabled) await loginMuiFixture(context.request, 'disabled');
        const page = await context.newPage();
        await page.goto(`${isolatedMuiOrigin()}/me/topics`);
        await expect(page).toHaveURL(/\/signin\?callbackUrl=\/me\/topics$/);
        await expect(screen(page)).toHaveCount(0);
        await expect(page.getByText(firstTitle, { exact: true })).toHaveCount(0);
      } finally { await context.close(); }
    }
  });

  test('real follow ownership, issue aggregation and unread cursors survive reload without marking topics read', async ({ page, context }) => {
    await loginMuiFixture(context.request);
    await page.goto('/me/topics');
    await expect(screen(page).getByRole('article')).toHaveCount(2);
    const first = screen(page).getByRole('article', { name: firstTitle, exact: true });
    await expect(first.getByText('2 个活跃议题', { exact: true })).toBeVisible();
    await expect(first.getByText('新出现的验证结果', { exact: true })).toBeVisible();
    await expect(first.getByText('1 个未读议题', { exact: true })).toBeVisible();
    await expect(first.getByRole('link', { name: firstTitle, exact: true })).toHaveAttribute('href', '/topics/mui-topic-1');
    await expect(first.getByRole('link', { name: '最近研究：编码代理验证方法的团队研究', exact: true })).toHaveAttribute('href', /^\/researches\/[0-9a-f-]{36}$/);
    await expect(screen(page).getByText('上次查看 从未', { exact: true })).toBeVisible();
    await expect(screen(page).getByText('共 2 个专题，2 个未读议题', { exact: true })).toBeVisible();
    await expect(screen(page).getByText('MUI 专题 5', { exact: true })).toHaveCount(0);
    await expect(screen(page).getByText('另一位成员的私有草稿', { exact: true })).toHaveCount(0);
    await page.reload();
    await expect(screen(page).getByText('共 2 个专题，2 个未读议题', { exact: true })).toBeVisible();
  });

  test('other-member and empty-admin views do not inherit the member’s follows', async ({ browser }) => {
    for (const identity of ['other', 'admin'] as const) {
      const context = await browser.newContext();
      try {
        await loginMuiFixture(context.request, identity);
        const page = await context.newPage();
        await page.goto(`${isolatedMuiOrigin()}/me/topics`);
        await expect(screen(page).getByRole('article')).toHaveCount(identity === 'other' ? 1 : 0);
        await expect(screen(page).getByText(firstTitle, { exact: true })).toHaveCount(0);
        if (identity === 'other') {
          await expect(screen(page).getByRole('heading', { name: 'MUI 专题 5', exact: true })).toBeVisible();
          await expect(screen(page).getByText('共 1 个专题，0 个未读议题', { exact: true })).toBeVisible();
        } else {
          await expect(screen(page).getByRole('heading', { name: '还没有关注', exact: true })).toBeVisible();
          await expect(screen(page).getByRole('link', { name: '去专题列表 →', exact: true })).toHaveAttribute('href', '/topics');
          expect((await new AxeBuilder({ page }).include('[data-my-topics-screen]').analyze()).violations).toEqual([]);
        }
      } finally { await context.close(); }
    }
  });

  for (const theme of ['light', 'dark'] as const) {
    test(`${theme}: real personal content uses shared hierarchy, five widths and accessible keyboard links`, async ({ page, context }, testInfo) => {
      await loginMuiFixture(context.request);
      await page.addInitScript(mode => localStorage.setItem('dr-theme', mode), theme);
      const errors: string[] = [];
      page.on('pageerror', error => errors.push(error.message));
      for (const width of [1440, 1024, 768, 390, 320]) {
        await page.setViewportSize({ width, height: 1000 });
        await page.goto('/me/topics');
        const first = screen(page).getByRole('article', { name: firstTitle, exact: true });
        await expect(first.getByRole('heading', { level: 2 })).toHaveCSS('font-size', '16px');
        await expect(first.locator('p').first()).toHaveCSS('font-size', '14px');
        await expect(first.locator('time')).toHaveCSS('font-size', '12px');
        await expect(page.locator('html')).toHaveClass(new RegExp(theme));
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
        expect((await new AxeBuilder({ page }).include('[data-my-topics-screen]').analyze()).violations).toEqual([]);
        await page.screenshot({ path: testInfo.outputPath(`my-topics-${theme}-${width}.png`), fullPage: true });
      }
      const link = screen(page).getByRole('link', { name: firstTitle, exact: true });
      await link.focus();
      await expect(link).toHaveCSS('outline-style', 'solid');
      await expect(link).toBeFocused();
      expect(errors).toEqual([]);
    });

    test(`${theme}: personal RSC remains visible with scripts held and hydrates without replacement`, async ({ page, context }) => {
      await loginMuiFixture(context.request);
      await page.addInitScript(mode => localStorage.setItem('dr-theme', mode), theme);
      const errors: string[] = [];
      page.on('pageerror', error => errors.push(error.message));
      let release!: () => void;
      const ready = new Promise<void>(resolve => { release = resolve; });
      let held = 0;
      await page.route('**/_next/static/**/*.js', async route => { held++; await ready; await route.continue(); });
      try {
        await page.goto('/me/topics', { waitUntil: 'commit' });
        await expect(screen(page).getByRole('heading', { name: firstTitle, exact: true })).toBeVisible();
        await expect.poll(() => held).toBeGreaterThan(0);
        await expect(screen(page).getByRole('article')).toHaveCount(2);
      } finally { release(); }
      await page.waitForLoadState('networkidle');
      await page.getByRole('button', { name: '打开用户菜单' }).click();
      await expect(page.getByRole('menuitem', { name: '个人设置', exact: true })).toBeVisible();
      await page.keyboard.press('Escape');
      await expect(screen(page).getByText('共 2 个专题，2 个未读议题', { exact: true })).toBeVisible();
      expect(errors).toEqual([]);
    });
  }

  test('coarse targets and 200% reduced-motion layout proxy preserve both topic and research links', async ({ browser }) => {
    const context = await browser.newContext({ hasTouch: true, viewport: { width: 768, height: 1000 }, reducedMotion: 'reduce' });
    try {
      await loginMuiFixture(context.request);
      const page = await context.newPage();
      await page.goto(`${isolatedMuiOrigin()}/me/topics`);
      for (const link of await screen(page).getByRole('link').all()) expect((await link.boundingBox())!.height).toBeGreaterThanOrEqual(44);
      await page.evaluate(() => { document.documentElement.style.zoom = '2'; });
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      await expect(screen(page).getByRole('link', { name: firstTitle, exact: true })).toBeVisible();
      expect((await new AxeBuilder({ page }).include('[data-my-topics-screen]').analyze()).violations).toEqual([]);
    } finally { await context.close(); }
  });
});
