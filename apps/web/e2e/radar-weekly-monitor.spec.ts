import { expect, test } from '@playwright/test';
import { loginWithCredentials } from './fixtures';

const sourceId = '00000000-0000-4000-8000-000000000001';
const run = (index: number, totalFetched: number) => ({
  id: `run-${index}`, sourceId, sourceName: '测试 RSS 来源', sourceType: 'rss',
  triggeredBy: 'cron', status: 'completed', totalFetched, totalNew: 0,
  totalSkipped: 0, totalFailed: 0, skippedExisting: 0, skippedRuleNoise: 0,
  skippedDistilledNoise: 0, skippedConflict: 0, candidateCount: 0, scoredCount: 0,
  pendingScoreCount: 0, sourcePendingScoreCount: 17, fallbackCount: 2,
  costStatus: 'unavailable', costUsd: 0, enrichedCount: 0, pendingEnrichmentCount: 0,
  elapsedMs: 1000, errorCode: null, errorMessage: null,
  createdAt: new Date(Date.now() - index * 60_000).toISOString(),
  completedAt: new Date(Date.now() - index * 60_000).toISOString(),
});

for (const width of [390, 1440]) {
  test(`radar backlog and empty-source warnings stay visible at ${width}px`, async ({ page }) => {
    await loginWithCredentials(page.context().request, { email: 'e2e-admin@e2e.local', role: 'admin' });
    await page.route('**/api/admin/radar/runs?*', (route) => route.fulfill({
      json: [run(0, 0), run(1, 0), run(2, 0), run(3, 10)],
    }));
    await page.setViewportSize({ width, height: 900 });
    await page.goto('/admin');
    await page.getByText('雷达运行明细', { exact: true }).click();
    const surface = width < 768
      ? page.locator('div').filter({ hasText: '测试 RSS 来源' }).filter({ hasText: '当日连续空结果 3 次' }).filter({ hasText: '当前待评分 17' }).last()
      : page.locator('tr').filter({ hasText: '测试 RSS 来源' });
    await expect(page.getByText('当前待评分', { exact: true }).first()).toBeVisible();
    await expect(surface.getByText('当日连续空结果 3 次')).toBeVisible();
    await expect(surface.getByText(/当前待评分 17/)).toBeVisible();
    await expect(surface.getByText(/本次降级 2/)).toBeVisible();
    await expect(surface.getByText('本次费用未记录')).toBeVisible();
    await page.getByRole('button', { name: /异常 1/ }).click();
    await expect(surface).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  });
}
