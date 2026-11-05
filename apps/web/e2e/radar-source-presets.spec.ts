import { test, expect } from './fixtures';

for (const viewport of [{ width: 1440, height: 900 }, { width: 390, height: 844 }]) {
  test(`admin can review and add a preset at ${viewport.width}px`, async ({ page }) => {
    await page.setViewportSize(viewport);
    let added = false;
    await page.route('**/api/admin/radar/source-presets', async (route) => {
      if (route.request().method() === 'POST') {
        expect(route.request().postDataJSON()).toEqual({ presetId: 'simon-willison-entries' });
        added = true;
        await route.fulfill({ status: 201, json: { created: true, existing: [{ id: 'new', name: 'Simon Willison 的博客', enabled: true, autoPaused: false }] } });
      } else {
        await route.fulfill({ json: { items: [
          { id: 'simon-willison-entries', name: 'Simon Willison 的博客', description: '作者的长篇文章', feedUrl: 'https://simonwillison.net/atom/entries/', existing: added ? [{ id: 'new', name: 'Simon Willison 的博客', enabled: true, autoPaused: false }] : [] },
          { id: 'nvidia-developer-blog', name: 'NVIDIA Developer Blog', description: '开发者博客', feedUrl: 'https://developer.nvidia.com/blog/feed/', existing: [{ id: 'old', name: '已配置来源', enabled: false, autoPaused: false }] },
        ] } });
      }
    });
    await page.goto('/admin');
    await page.getByRole('tab', { name: '雷达治理' }).click();
    await expect(page.getByRole('heading', { name: '添加技术信息源' })).toBeVisible();
    await expect(page.getByText('已存在：已配置来源（已停用）')).toBeVisible();
    await expect(page.getByRole('button', { name: '添加 NVIDIA Developer Blog' })).toHaveCount(0);
    await page.getByRole('button', { name: '添加 Simon Willison 的博客' }).click();
    await expect(page.getByText('来源已添加，将按现有同步计划读取。')).toBeVisible();
    await expect(page.getByText('已存在：Simon Willison 的博客（已启用）')).toBeVisible();
    const section = page.getByRole('region', { name: '添加技术信息源' });
    const bounds = await section.boundingBox();
    expect(bounds).not.toBeNull();
    expect(bounds!.x).toBeGreaterThanOrEqual(0);
    expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(viewport.width);
  });
}
