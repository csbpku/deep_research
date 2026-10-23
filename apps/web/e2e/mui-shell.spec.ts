import { test, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';

test.describe('MUI shell contracts (no database writes)', () => {
  for (const theme of ['light', 'dark'] as const) {
    test(`${theme}: streamed main content remains server-rendered before delayed scripts hydrate`, async ({ page }) => {
      const errors: string[] = [];
      page.on('pageerror', error => errors.push(error.message));
      page.on('console', message => {
        if (message.type() === 'error' && /hydration|did not match/i.test(message.text())) errors.push(message.text());
      });
      await page.addInitScript(mode => localStorage.setItem('dr-theme', mode), theme);
      await page.route('**/api/auth/session', route => route.fulfill({ json: { user: null } }));
      await page.route('**/api/radar?*', route => route.fulfill({ json: { page: 1, perPage: 20, total: 0, totalPages: 1, items: [] } }));
      let releaseScripts!: () => void;
      const scriptsReady = new Promise<void>(resolve => { releaseScripts = resolve; });
      let heldScripts = 0;
      await page.route('**/_next/static/**/*.js', async route => {
        heldScripts++;
        await scriptsReady;
        await route.continue();
      });
      try {
        await page.goto('/radar?date=all', { waitUntil: 'commit' });
        // A client-only workaround would lose this heading while bundles wait.
        await expect(page.getByRole('main').getByRole('heading', { name: '技术雷达', exact: true })).toBeVisible();
        // globals.css leaves line-height to the shared MUI theme, so this also
        // confirms the CssBaseline token is emitted through the SSR cache.
        const baselineLineHeightRatio = await page.locator('body').evaluate(element => {
          const style = getComputedStyle(element);
          const lineHeight = Number.parseFloat(style.lineHeight);
          const fontSize = Number.parseFloat(style.fontSize);
          return style.lineHeight.endsWith('px') ? lineHeight / fontSize : lineHeight;
        });
        expect(baselineLineHeightRatio).toBeCloseTo(1.6);
        await expect.poll(() => heldScripts).toBeGreaterThan(0);
      } finally {
        releaseScripts();
      }
      await expect(page.getByRole('heading', { name: '当前筛选没有内容' })).toBeVisible();
      await expect(page.locator('html')).toHaveClass(new RegExp(theme));
      const trigger = page.getByRole('button', { name: '切换主题' });
      await trigger.click();
      await expect(page.getByRole('menuitemradio', { name: theme === 'dark' ? '深色' : '浅色', exact: true })).toHaveAttribute('aria-checked', 'true');
      await page.keyboard.press('Escape');
      await expect(trigger).toBeFocused();
      expect(errors).toEqual([]);
    });
  }

  test('mobile navigation returns focus and exposes the active route', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto('/radar?date=all');
    const trigger = page.getByRole('button', { name: '打开导航' });
    await trigger.click();
    const drawer = page.getByRole('dialog', { name: '主导航', exact: true });
    await expect(drawer.getByRole('link', { name: '技术雷达' })).toHaveAttribute('aria-current', 'page');
    await expect(drawer.getByRole('link', { name: '研究库' })).toHaveAttribute('href', '/researches');
    expect((await new AxeBuilder({ page }).include('.MuiDrawer-root').analyze()).violations).toEqual([]);
    await page.keyboard.press('Escape');
    await expect(drawer).not.toBeVisible();
    await expect(trigger).toBeFocused();
  });

  test('theme menu persists one mode source and restores trigger focus', async ({ page }) => {
    await page.addInitScript(() => { if (!localStorage.getItem('dr-theme')) localStorage.setItem('dr-theme', 'light'); });
    await page.goto('/radar?date=all');
    const trigger = page.getByRole('button', { name: '切换主题' });
    await trigger.click();
    const dark = page.getByRole('menuitemradio', { name: '深色', exact: true });
    await expect(dark).toHaveAttribute('aria-checked', 'false');
    await dark.click();
    await expect(trigger).toBeFocused();
    await expect(page.locator('html')).toHaveClass(/dark/);
    expect(await page.evaluate(() => localStorage.getItem('dr-theme'))).toBe('dark');
    expect(await page.evaluate(() => Object.keys(localStorage).filter(key => /mui.*(?:mode|color-scheme)/i.test(key)))).toEqual([]);
    await page.goto('/search');
    await expect(page.locator('html')).toHaveClass(/dark/);
    // The menu reports the stored preference, not only the resolved color.
    await trigger.click();
    await page.getByRole('menuitemradio', { name: '跟随系统' }).click();
    expect(await page.evaluate(() => localStorage.getItem('dr-theme'))).toBe('system');
    await page.reload();
    await trigger.click();
    await expect(page.getByRole('menuitemradio', { name: '跟随系统' })).toHaveAttribute('aria-checked', 'true');
    await page.keyboard.press('Escape');
    await expect(trigger).toBeFocused();
  });

  test('skip link and global shortcut preserve keyboard navigation', async ({ page }) => {
    await page.goto('/radar?date=all');
    await page.keyboard.press('Tab');
    const skip = page.getByRole('link', { name: '跳到主要内容' });
    await expect(skip).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(page.getByRole('main')).toBeFocused();
    const isMac = await page.evaluate(() => /Mac/i.test(navigator.platform));
    await page.keyboard.press(isMac ? 'Meta+k' : 'Control+k');
    await expect(page).toHaveURL(/\/search$/);
  });

  test('real and development review entries hydrate; production closes the review entry', async ({ page }) => {
    const errors: string[] = [];
    page.on('pageerror', error => errors.push(error.message));
    page.on('console', message => { if (message.type() === 'error' && /hydration|did not match/i.test(message.text())) errors.push(message.text()); });
    for (const path of ['/radar?date=all', '/mui-demo?date=all']) {
      const response = await page.goto(path);
      if (process.env.E2E_PRODUCTION === '1' && path.startsWith('/mui-demo')) {
        expect(response?.status()).toBe(404);
        await expect(page.getByRole('heading', { name: '技术雷达', exact: true })).not.toBeVisible();
        continue;
      }
      expect(response?.status()).toBe(200);
      await expect(page.getByRole('heading', { name: '技术雷达', exact: true })).toBeVisible();
      await expect(page.getByRole('button', { name: '切换主题' })).toBeVisible();
      await page.getByRole('button', { name: '切换主题' }).click();
      await expect(page.getByRole('menuitemradio', { name: '浅色', exact: true })).toBeVisible();
      await page.keyboard.press('Escape');
    }
    expect(errors).toEqual([]);
  });
});
