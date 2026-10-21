import { test, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';

const id = '10000000-0000-4000-8000-000000000019';
// Exercise the actual reading route without database writes or bypassing BFF auth.
// This fixture verifies presentation, not server-side permissions.
const research = {
  id, type: 'research', status: 'published', title: '公共领域组件迁移回归',
  body: '## 研究内容\n\n正文保留链接与代码。\n\n[参考资料](https://example.com/reference)\n\n```ts\nconst value = 0;\n```',
  background: '背景说明，明确事实边界。', conclusion: '结论说明。', risks: '风险仍需核验。',
  tags: ['RAG 与检索', 'long-unbroken-tag-'.repeat(8)], authorId: 'fixture-author',
  creationMethod: 'ai_research', aiAssisted: false, publishedAt: '2026-10-19T00:00:00Z',
  featuredAt: '2026-10-19T00:00:00Z', createdAt: '2026-10-19T00:00:00Z', updatedAt: '2026-10-19T00:00:00Z',
  author: { id: 'fixture-author', name: '测试作者' }, canEdit: false, canManageStatus: false,
  researchSources: [], sourceComment: null, commentCount: 0, audits: [],
};

for (const theme of ['light', 'dark'] as const) {
  test(`${theme}: shared sections and badges preserve the real reading route`, async ({ page }, testInfo) => {
    const errors: string[] = [];
    page.on('pageerror', error => errors.push(`${page.viewportSize()?.width}: ${error.message}`));
    page.on('console', message => {
      if (message.type() === 'error' && /hydration|did not match/i.test(message.text())) errors.push(message.text());
    });
    await page.addInitScript(mode => localStorage.setItem('dr-theme', mode), theme);
    await page.route(`**/api/researches/${id}`, route => route.fulfill({ json: research }));
    for (const width of [1440, 1024, 768, 390, 320]) {
      await page.setViewportSize({ width, height: 900 });
      await page.goto(`/researches/${id}`);
      await expect(page.getByRole('heading', { level: 1, name: research.title })).toBeVisible();
      await expect(page.locator('html')).toHaveClass(new RegExp(theme));
      const summary = page.locator('section[data-section-variant="reading"]');
      await expect(summary.getByRole('heading', { level: 2, name: '研究摘要' })).toBeVisible();
      const info = summary.locator('section[data-section-tone="info"]');
      await expect(info.getByRole('heading', { name: '背景', exact: true })).toBeVisible();
      await expect(info).toContainText(research.background);
      await expect(summary.locator('section[data-section-tone="success"]')).toContainText(research.conclusion);
      await expect(summary.locator('section[data-section-tone="destructive"]')).toContainText(research.risks);
      expect(await info.evaluate(element => {
        const heading = element.querySelector('h2')!;
        const body = element.querySelector('[data-body-spacing]')!;
        return { font: getComputedStyle(heading).fontSize, padding: getComputedStyle(body).padding };
      })).toEqual({ font: '16px', padding: '16px' });
      await expect(page.locator('[data-status-kind="researchType"]')).toHaveText('研究报告');
      await expect(page.locator('[data-status-kind="method"]')).toHaveText('AI 调研');
      await expect(page.locator('[data-status-kind="featured"]')).toHaveText('精华');
      await expect(page.getByRole('link', { name: '参考资料', exact: true })).toHaveAttribute('href', 'https://example.com/reference');
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      // No exemptions; scope to migrated regions rather than claiming the old workbench is migrated.
      const results = await new AxeBuilder({ page }).include('section[data-section-tone]').include('[data-status-kind]').analyze();
      expect(results.violations).toEqual([]);
      if (width === 390) await page.screenshot({ path: testInfo.outputPath(`domain-reading-${theme}-390.png`), fullPage: true });
    }
    expect(errors).toEqual([]);
  });
}
