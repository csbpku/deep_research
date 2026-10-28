import { test, expect, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';

const jobId = 'f0600000-0000-4000-8000-000000000001';
const content = '# 异步任务的失败边界\n\n## Slide 1: 失败后的其他任务，谁来收尾？\n\n先区分异常传播与任务取消。\n\n## Slide 2: 默认首错，不等于整组取消\n\n- gather 立即传播首个异常，其他任务继续运行。[Python asyncio 官方文档](https://docs.python.org/3/library/asyncio-task.html)\n- TaskGroup 遇到非取消异常，会取消剩余任务。[Python asyncio 官方文档](https://docs.python.org/3/library/asyncio-task.html)\n- 需要收集所有结果时，用 return_exceptions 明确处理异常。[Python asyncio 官方文档](https://docs.python.org/3/library/asyncio-task.html)\n\n## Slide 3: 核对取消与清理\n\n- 用三个并发任务核对失败后的状态。\n- 检查 finally 清理逻辑。';

async function mockSlides(page: Page) {
  await page.route('**/api/ai-research/jobs*', route => route.fulfill({ json: { items: [], total: 0 } }));
  await page.route('**/api/ai-research/conversations*', route => route.fulfill({ json: { items: [] } }));
  await page.route(`**/api/ai-research/conversations/by-job/${jobId}`, route => route.fulfill({ status: 404, body: 'not found' }));
  await page.route(`**/api/ai-research/${jobId}`, route => route.fulfill({ json: {
    jobId, status: 'succeeded', finalStatus: 'succeeded', currentStep: 'write', topic: '异步任务的失败边界',
    sourcesCount: 1, savedSourcesCount: 1, partialSourcesCount: 1, failedSourcesCount: 0,
    userSourceRefsCount: 1, autoSourceRefsCount: 0, reportType: 'slides', reportLength: 'standard', deliverableStatus: 'report', sourcePolicy: 'only_user_sources',
    researchProgress: null, outputText: null, errorCode: null, errorMessage: null, errorDetails: null,
    startedAt: '2026-10-28T00:00:00Z', createdAt: '2026-10-28T00:00:00Z', completedAt: '2026-10-28T00:00:18Z',
    draftResearchId: 'f0600000-0000-4000-8000-000000000002',
    review: { phase: 'completed', status: 'passed', attempts: 1, corrected_count: 0, unverified_count: 0, contradicted_count: 0, claims: [] },
    conversation: [], sources: [], artifact: { type: 'slides', title: '异步任务的失败边界', version: 1, mimeType: 'text/markdown', content, rawContent: null, payload: null, sourceRefs: [], sourceHash: null },
  } }));
}

for (const mode of ['light', 'dark']) test(`${mode}: slides keep readable contrast and compact source labels`, async ({ page }, testInfo) => {
  await page.addInitScript(theme => localStorage.setItem('dr-theme', theme), mode);
  await mockSlides(page);
  await page.goto(`/ai-research/${jobId}`);
  await page.getByRole('button', { name: '跳到第 2 页', exact: true }).click();
  const stage = page.locator('[data-slide-stage]');
  await expect(stage).toContainText('其他任务继续运行');
  const contrast = await stage.locator('p, li').evaluateAll(elements => {
    const rgb = (value: string) => (value.match(/[\d.]+/g) ?? []).slice(0, 3).map(Number);
    const luminance = (c: number[]) => c.map(v => v / 255).map(v => v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4).reduce((sum, v, i) => sum + v * [0.2126, 0.7152, 0.0722][i], 0);
    return elements.map(el => {
      let parent: Element | null = el;
      while (parent && getComputedStyle(parent).backgroundColor === 'rgba(0, 0, 0, 0)') parent = parent.parentElement;
      const bg = rgb(getComputedStyle(parent!).backgroundColor);
      const fg = rgb(getComputedStyle(el).color);
      const [a, b] = [luminance(bg), luminance(fg)].sort((x, y) => y - x);
      return (a + 0.05) / (b + 0.05);
    });
  });
  expect(contrast.length).toBeGreaterThan(0);
  for (const ratio of contrast) expect(ratio).toBeGreaterThanOrEqual(4.5);
  await expect(stage.getByText('Python asyncio 官方文档', { exact: true })).toHaveCount(0);
  await expect(stage.getByRole('link', { name: /来源 1/ })).toBeVisible();
  const issues = await new AxeBuilder({ page }).include('[aria-label="Slides 提纲预览"]').analyze();
  expect(issues.violations).toEqual([]);
  await stage.scrollIntoViewIfNeeded();
  await page.screenshot({ path: testInfo.outputPath(`slides-${mode}.png`) });
});

for (const width of [390, 1024, 1440]) test(`slides fit the reading surface at ${width}px without inner scrolling`, async ({ page }) => {
  await page.setViewportSize({ width, height: 1000 });
  await mockSlides(page);
  await page.goto(`/ai-research/${jobId}`);
  await page.getByRole('button', { name: '跳到第 2 页', exact: true }).click();
  const stage = page.locator('[data-slide-stage]');
  const overflow = await stage.evaluate(el => ({
    page: document.documentElement.scrollWidth, viewport: innerWidth,
    scrollingChildren: Array.from(el.querySelectorAll('*')).filter(child => {
      const style = getComputedStyle(child);
      return ['auto', 'scroll'].includes(style.overflowY) && child.scrollHeight > child.clientHeight + 1;
    }).length,
    height: el.scrollHeight, clientHeight: el.clientHeight,
  }));
  expect(overflow.page).toBeLessThanOrEqual(overflow.viewport);
  expect(overflow.scrollingChildren).toBe(0);
  expect(overflow.height).toBeLessThanOrEqual(overflow.clientHeight + 1);
});

test('slide keyboard shortcuts stay inside the preview', async ({ page }) => {
  await mockSlides(page);
  await page.goto(`/ai-research/${jobId}`);
  await page.getByRole('button', { name: '跳到第 2 页', exact: true }).click();
  const composer = page.getByRole('textbox', { name: '研究对话输入', exact: true });
  await composer.pressSequentially('one two');
  await expect(page.locator('[data-slide-stage]')).toHaveAccessibleName(/^演示第 2 页/);
  await composer.press('ArrowLeft');
  await expect(page.locator('[data-slide-stage]')).toHaveAccessibleName(/^演示第 2 页/);
  const stage = page.locator('[data-slide-stage]');
  await stage.focus();
  await page.keyboard.press('ArrowRight');
  await expect(stage).toHaveAccessibleName(/^演示第 3 页/);
  await page.keyboard.press('Home');
  await expect(stage).toHaveAccessibleName(/^演示第 1 页/);
});
