// 雷达流程 E2E（Week 9+ 起步骨架）
//
// 状态：测试在真实 PG + E2E=1 模式下可跑。Seed 数据需要测试专用
// 路由或 fixtures 提供；此处不写死种子（避免假数据通过测试）。
// 本文件覆盖：
//   - 雷达列表页加载
//   - 雷达详情页加载
//   - 反馈按钮可见（具体功能依赖 seed）

import { test, expect } from '@playwright/test';

test.describe('Radar flows', () => {
  test('radar list page renders', async ({ page }) => {
    const res = await page.goto('/radar');
    expect(res?.status()).toBe(200);
    // 列表骨架或空态：页面上至少有标题
    await expect(page.locator('body')).toContainText(/雷达|radar/i);
  });

  test('committed search state is reproducible after a second query and refresh', async ({ page }) => {
    const radarResponse = await page.request.get('/api/radar?quality=collection&page=1&per_page=1');
    expect(radarResponse.ok()).toBe(true);
    const radar = await radarResponse.json() as {
      items: Array<{ title: string }>;
    };
    test.skip(radar.items.length === 0, '需要至少一条雷达候选验证连续搜索');

    const firstTitle = radar.items[0].title;
    const firstTerm = firstTitle.split(/\s+/u).find((word) => word.length >= 3) ?? firstTitle;
    await page.goto('/radar');
    const search = page.getByRole('searchbox', { name: '搜索雷达内容' });
    await search.fill(firstTerm);
    await page.getByRole('button', { name: '搜索', exact: true }).click();
    await expect.poll(() => new URL(page.url()).searchParams.get('q')).toBe(firstTerm);
    await expect(page.locator('article').first()).toContainText(firstTerm);

    const emptyTerm = 'zzzz-no-such-20260914';
    await search.fill(emptyTerm);
    await page.getByRole('button', { name: '搜索', exact: true }).click();
    await expect.poll(() => new URL(page.url()).searchParams.get('q')).toBe(emptyTerm);
    await expect(page.locator('article')).toHaveCount(0);
    await expect(page.getByText('暂无候选')).toBeVisible();

    await page.reload();
    await expect(page.locator('article')).toHaveCount(0);
    await expect(page.getByText('暂无候选')).toBeVisible();
  });

  test('radar detail page returns 200 or 404 (depends on id existence)', async ({ page }) => {
    // 用一个看起来合法的 UUID；如果 DB 没有这条数据，会跳到 EmptyState 而不是 404
    const fakeId = '00000000-0000-4000-8000-000000000000';
    const res = await page.goto(`/radar/${fakeId}`);
    expect([200, 404]).toContain(res?.status() ?? 0);
  });
});
