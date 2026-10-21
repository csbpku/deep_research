import { test, expect } from '@playwright/test';
import { loginMuiFixture } from './mui-local-fixtures';

const modules = ['仪表板', '雷达治理', '研究库', '主题提议', '用户分享', '评论提名', 'LLM 用量', '成员'];

test.describe('MUI Admin module navigation (isolated fixture database)', () => {
  test.beforeEach(async ({ page }) => {
    await loginMuiFixture(page.request, 'admin');
    // Module switching only reads data; do not allow governance mutations here.
    await page.route('**/api/**', route => ['GET', 'HEAD'].includes(route.request().method())
      ? route.continue() : route.abort('blockedbyclient'));
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto('/admin');
    await expect(page.getByRole('heading', { name: 'Admin 控制台', exact: true })).toBeVisible();
  });

  test('every module switches by click and keeps its icon beside its label', async ({ page }, testInfo) => {
    const errors: string[] = [];
    page.on('pageerror', error => errors.push(error.message));
    const list = page.getByRole('tablist', { name: 'Admin 模块' });
    await expect(list.getByRole('tab', { selected: true })).toHaveText('仪表板');

    for (const label of modules) {
      const tab = list.getByRole('tab', { name: label, exact: true });
      await tab.click();
      await expect(tab).toHaveAttribute('aria-selected', 'true');
      await expect(list.getByRole('tab', { selected: true })).toHaveCount(1);
      await expect(tab).toHaveAttribute('tabindex', '0');
      await expect(page.getByRole('tabpanel', { name: label, exact: true })).toBeVisible();
      await expect(tab).toHaveCSS('flex-direction', 'row');
      await expect(tab).toHaveCSS('align-items', 'center');
    }

    await list.getByRole('tab', { name: '仪表板', exact: true }).click();
    await page.screenshot({ path: testInfo.outputPath('admin-tabs.png'), fullPage: true });
    expect(errors).toEqual([]);
  });

  test('arrow keys move focus and Enter/Space select the focused module', async ({ page }) => {
    const list = page.getByRole('tablist', { name: 'Admin 模块' });
    const dashboard = list.getByRole('tab', { name: '仪表板', exact: true });
    const radar = list.getByRole('tab', { name: '雷达治理', exact: true });
    const users = list.getByRole('tab', { name: '成员', exact: true });
    await dashboard.focus();
    await page.keyboard.press('ArrowRight');
    await expect(radar).toBeFocused();
    await expect(dashboard).toHaveAttribute('aria-selected', 'true');
    await page.keyboard.press('Enter');
    await expect(radar).toHaveAttribute('aria-selected', 'true');
    await expect(page.getByRole('tabpanel', { name: '雷达治理', exact: true })).toBeVisible();
    await page.keyboard.press('End');
    await expect(users).toBeFocused();
    await page.keyboard.press('Space');
    await expect(users).toHaveAttribute('aria-selected', 'true');
    await expect(page.getByRole('tabpanel', { name: '成员', exact: true })).toBeVisible();
    await page.keyboard.press('Home');
    await expect(dashboard).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(dashboard).toHaveAttribute('aria-selected', 'true');
  });

  test('narrow screens keep scrollable tabs without a module selection dropdown', async ({ page }, testInfo) => {
    await page.setViewportSize({ width: 390, height: 844 });
    const list = page.getByRole('tablist', { name: 'Admin 模块' });
    await expect(list).toBeVisible();
    await expect(page.getByRole('combobox', { name: 'Admin 模块', exact: true })).toHaveCount(0);
    expect((await list.boundingBox())!.width).toBeLessThanOrEqual(390);
    for (const label of modules) {
      const tab = list.getByRole('tab', { name: label, exact: true });
      await tab.click();
      await expect(tab).toHaveAttribute('aria-selected', 'true');
      await expect(page.getByRole('tabpanel', { name: label, exact: true })).toBeVisible();
      await expect(tab).toHaveCSS('flex-direction', 'row');
    }
    await page.screenshot({ path: testInfo.outputPath('admin-tabs-mobile.png'), fullPage: true });
  });
});
