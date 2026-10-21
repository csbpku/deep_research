import { test, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { isolatedMuiOrigin, loginMuiFixture } from './mui-local-fixtures';

test.describe('MUI personal workspace', () => {
  test.skip(process.env.MUI_ISOLATED_BROWSER !== '1', 'Requires the isolated synthetic database');
  test.beforeEach(() => { isolatedMuiOrigin(); });

  test('direct tab links and keyboard navigation retain the five workspace destinations', async ({ page, context }) => {
    await loginMuiFixture(context.request);
    const tabs = [
      ['drafts', '草稿'],
      ['bookmarks', '收藏'],
      ['templates', '模板'],
      ['notifications', '通知'],
      ['preferences', '设置'],
    ] as const;

    for (const [value, label] of tabs) {
      await page.goto(`/me?tab=${value}`);
      const tab = page.getByRole('tab', { name: label, exact: true });
      await expect(tab).toHaveAttribute('aria-selected', 'true');
      await expect(page.getByRole('tabpanel')).toHaveAttribute('aria-labelledby', `me-tab-${value}`);
    }

    await page.goto('/me');
    const drafts = page.getByRole('tab', { name: '草稿', exact: true });
    const bookmarks = page.getByRole('tab', { name: '收藏', exact: true });
    await drafts.focus();
    await page.keyboard.press('ArrowRight');
    await expect(bookmarks).toHaveAttribute('aria-selected', 'true');
  });

  test('bookmark removal uses the shared dialog and cancellation leaves the item intact', async ({ page, context }) => {
    let deleteCalled = false;
    await page.route('**/api/me/bookmarks*', async route => {
      if (route.request().method() === 'DELETE') {
        deleteCalled = true;
        await route.fulfill({ json: { ok: true, deleted: 1 } });
        return;
      }
      await route.continue();
    });

    await loginMuiFixture(context.request);
    await page.goto('/me?tab=bookmarks');
    const remove = page.getByRole('button', { name: '移除收藏:编码代理验证方法的团队研究' });
    await remove.click();
    const dialog = page.getByRole('dialog', { name: '移除收藏' });
    await expect(dialog).toContainText('移除后可以在原页面重新添加。');
    await dialog.getByRole('button', { name: '取消' }).click();
    await expect(dialog).toHaveCount(0);
    await expect(remove).toBeVisible();
    expect(deleteCalled).toBe(false);
  });

  test('preference Selects load, preserve supported values, and submit the same API shape', async ({ page, context }) => {
    let saved: Record<string, unknown> | null = null;
    await page.route('**/api/me/preferences', async route => {
      if (route.request().method() === 'GET') {
        await route.fulfill({ json: { preferences: { defaultReportType: 'research_report', defaultSourcePolicy: 'prefer_user_sources' } } });
        return;
      }
      if (route.request().method() === 'PUT') {
        saved = route.request().postDataJSON() as Record<string, unknown>;
        await route.fulfill({ json: { ok: true, preferences: saved } });
        return;
      }
      await route.continue();
    });

    await loginMuiFixture(context.request);
    await page.goto('/me?tab=preferences');
    const report = page.getByRole('combobox', { name: '默认报告类型' });
    const source = page.getByRole('combobox', { name: '默认来源策略' });
    await expect(report).toContainText('完整调研报告');
    await expect(source).toContainText('优先指定资料，可补充搜索');

    await report.click();
    await page.getByRole('option', { name: 'Slides 提纲' }).click();
    await source.click();
    await page.getByRole('option', { name: '仅使用网页搜索' }).click();
    await page.getByRole('button', { name: '保存设置' }).click();

    await expect(page.getByRole('status')).toContainText('已保存');
    expect(saved).toEqual({ defaultReportType: 'slides', defaultSourcePolicy: 'web_only' });
  });

  test('template dialog supports Escape, restores focus, validates fields, and submits the existing payload', async ({ page, context }) => {
    let created: Record<string, unknown> | null = null;
    let templates: Array<Record<string, unknown>> = [];
    await page.route('**/api/me/templates', async route => {
      if (route.request().method() === 'GET') {
        await route.fulfill({ json: { items: templates } });
        return;
      }
      if (route.request().method() === 'POST') {
        created = route.request().postDataJSON() as Record<string, unknown>;
        templates = [{
          id: 'mui-template-created', title: String(created.title), topic: String(created.topic),
          background: created.background ?? null, reportType: 'research_report', sourcePolicy: 'prefer_user_sources',
          tags: [], useCount: 0, lastUsedAt: null, createdAt: '2026-10-19T00:00:00.000Z', updatedAt: '2026-10-19T00:00:00.000Z',
        }];
        await route.fulfill({ json: { ok: true } });
        return;
      }
      await route.continue();
    });

    await loginMuiFixture(context.request);
    await page.goto('/me?tab=templates');
    const trigger = page.getByRole('button', { name: '新建模板' });
    await trigger.click();
    let dialog = page.getByRole('dialog', { name: '新建调研模板' });
    await expect(dialog.getByRole('button', { name: '创建' })).toBeDisabled();
    await page.keyboard.press('Escape');
    await expect(dialog).toHaveCount(0);
    await expect(trigger).toBeFocused();

    await trigger.click();
    dialog = page.getByRole('dialog', { name: '新建调研模板' });
    await dialog.getByRole('textbox', { name: '模板名称' }).fill('团队验证模板');
    await dialog.getByRole('textbox', { name: '调研主题' }).fill('a');
    await expect(dialog.getByRole('button', { name: '创建' })).toBeDisabled();
    await dialog.getByRole('textbox', { name: '调研主题' }).fill('如何验证编码代理的可靠性');
    await dialog.getByRole('textbox', { name: '背景（可选）' }).fill('聚焦多团队的可复现实验。');
    await dialog.getByRole('button', { name: '创建' }).click();
    await expect(dialog).toHaveCount(0);
    await expect(page.getByRole('heading', { name: '团队验证模板', exact: true })).toBeVisible();
    expect(created).toEqual({
      title: '团队验证模板', topic: '如何验证编码代理的可靠性', background: '聚焦多团队的可复现实验。', tags: [],
    });
  });

  test('notification bulk-read state is announced and refreshed after the PATCH', async ({ page, context }) => {
    let unread = true;
    await page.route('**/api/me/notifications', async route => {
      if (route.request().method() === 'GET') {
        await route.fulfill({ json: { unreadCount: unread ? 1 : 0, items: [{
          id: 'mui-notification-1', type: 'mention', readAt: unread ? null : '2026-10-19T00:01:00.000Z', createdAt: '2026-10-19T00:00:00.000Z',
          actor: { id: 'mui-actor-1', name: '测试成员', avatarUrl: null }, excerpt: '请查看这条讨论中的新证据。', href: '/topics/mui-topic-1',
        }] } });
        return;
      }
      if (route.request().method() === 'PATCH') {
        unread = false;
        await route.fulfill({ json: { ok: true } });
        return;
      }
      await route.continue();
    });

    await loginMuiFixture(context.request);
    await page.goto('/me?tab=notifications');
    await expect(page.getByRole('link', { name: /未读:测试成员 @了你/ })).toBeVisible();
    await page.getByRole('button', { name: '全部标为已读' }).click();
    await expect(page.getByText('全部已读', { exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: '全部标为已读' })).toHaveCount(0);
  });

  test('personal settings remain readable at narrow widths in light and dark themes', async ({ page, context }) => {
    await page.route('**/api/me/preferences', route => route.fulfill({ json: { preferences: {} } }));
    await loginMuiFixture(context.request);

    for (const theme of ['light', 'dark'] as const) {
      await page.addInitScript(mode => localStorage.setItem('dr-theme', mode), theme);
      for (const width of [1440, 768, 390, 320]) {
        await page.setViewportSize({ width, height: 900 });
        await page.goto('/me?tab=preferences');
        await expect(page.getByRole('combobox', { name: '默认报告类型' })).toBeVisible();
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
        expect((await new AxeBuilder({ page }).include('[data-me-workspace]').analyze()).violations).toEqual([]);
      }
    }
  });
});
