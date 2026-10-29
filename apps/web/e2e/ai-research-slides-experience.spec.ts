import { test, expect, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';

const jobId = 'f0600000-0000-4000-8000-000000000001';
const content = '# 异步任务的失败边界\n\n## Slide 1: 失败后的其他任务，谁来收尾？\n\n先区分异常传播与任务取消。\n\n## Slide 2: 默认首错，不等于整组取消\n\n- gather 立即传播首个异常，其他任务继续运行。[Python asyncio 官方文档](https://docs.python.org/3/library/asyncio-task.html)\n- TaskGroup 遇到非取消异常，会取消剩余任务。[Python asyncio 官方文档](https://docs.python.org/3/library/asyncio-task.html)\n- 需要收集所有结果时，用 return_exceptions 明确处理异常。[Python asyncio 官方文档](https://docs.python.org/3/library/asyncio-task.html)\n\n## Slide 3: 核对取消与清理\n\n- 用三个并发任务核对失败后的状态。\n- 检查 finally 清理逻辑。';

async function mockSlides(page: Page, slideContent = content) {
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
    conversation: [], sources: [], artifact: { type: 'slides', title: '异步任务的失败边界', version: 1, mimeType: 'text/markdown', content: slideContent, rawContent: null, payload: null, sourceRefs: [], sourceHash: null },
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
  await expect(stage.getByRole('link', { name: /来源 1/ }).first()).toBeVisible();
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
    over: Array.from(document.querySelectorAll('body *')).filter(e => e.getBoundingClientRect().right > innerWidth + 2).slice(0, 8).map(e => ({tag:e.tagName, label:e.getAttribute('aria-label'),class:e.className})),
    scrollingChildren: Array.from(el.querySelectorAll('*')).filter(child => {
      const style = getComputedStyle(child);
      return ['auto', 'scroll'].includes(style.overflowY) && child.scrollHeight > child.clientHeight + 1;
    }).length,
    height: el.scrollHeight, clientHeight: el.clientHeight,
  }));
  expect(overflow.page, JSON.stringify(overflow.over)).toBeLessThanOrEqual(overflow.viewport);
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

test('users can choose and retain slide style without changing the content', async ({ page }) => {
  await mockSlides(page);
  await page.goto(`/ai-research/${jobId}`);
  const stage = page.locator('[data-slide-stage]');
  await expect(stage).toHaveAttribute('data-slide-style', 'teaching');
  const style = page.getByRole('combobox', { name: 'Slides 风格', exact: true });
  await style.click();
  await page.getByRole('option', { name: '编辑式研究', exact: true }).click();
  await expect(stage).toHaveAttribute('data-slide-style', 'editorial');
  await expect(stage).toContainText('失败后的其他任务，谁来收尾');
  await page.reload();
  await expect(stage).toHaveAttribute('data-slide-style', 'editorial');
  await style.click();
  await page.getByRole('option', { name: '精确技术', exact: true }).click();
  await expect(stage).toHaveAttribute('data-slide-style', 'technical');
  await expect(stage).toContainText('失败后的其他任务，谁来收尾');
});

const groupedContent = '# 技术研究简报\n\n## Slide 1: 并发失败后的传播、任务取消与资源清理边界\n\n### gather 的默认行为\n- 首个异常传播给调用方，其余任务继续运行。[官方文档](https://docs.python.org/3/library/asyncio-task.html)\n- 后续任务仍需由调用方明确管理。\n\n### TaskGroup 的默认行为\n- 非取消异常会触发其余任务取消，并等待任务完成清理。\n- 退出时汇总异常组。[官方文档](https://docs.python.org/3/library/asyncio-task.html)\n\n## 参考文献\n- 不应作为演示正文的附录标题';
const viewports = [{ width: 375, height: 667 }, { width: 667, height: 375 }, { width: 768, height: 1024 }, { width: 1280, height: 720 }, { width: 1920, height: 1080 }];
for (const mode of ['light', 'dark'] as const) for (const style of ['technical', 'editorial', 'teaching'] as const) for (const viewport of viewports) {
  test(`${mode}/${style}: grouped slide is readable at ${viewport.width}x${viewport.height}`, async ({ page }, testInfo) => {
    await page.setViewportSize(viewport);
    await page.addInitScript(({ theme, slideStyle }) => { localStorage.setItem('dr-theme', theme); localStorage.setItem('ai-research-slides-style:v1', slideStyle); }, { theme: mode, slideStyle: style });
    await mockSlides(page, groupedContent);
    await page.goto(`/ai-research/${jobId}`);
    const stage = page.locator('[data-slide-stage]');
    await expect(stage).toHaveAttribute('data-slide-style', style);
    await expect(stage.locator('[data-slide-comparison]')).toBeVisible();
    await expect(stage).toContainText('gather 的默认行为');
    await expect(stage).toContainText('TaskGroup 的默认行为');
    await expect(stage.getByRole('link', { name: /来源 1/ }).first()).toBeVisible();
    await expect(stage).not.toContainText('不应作为演示正文的附录标题');
    const geometry = await stage.evaluate(el => ({ page: document.documentElement.scrollWidth, viewport: innerWidth, width: el.scrollWidth, clientWidth: el.clientWidth, height: el.scrollHeight, clientHeight: el.clientHeight,
      scrolling: [...el.querySelectorAll('*')].filter(child => ['auto', 'scroll'].includes(getComputedStyle(child).overflowY) && child.scrollHeight > child.clientHeight + 1).length }));
    expect(geometry.page).toBeLessThanOrEqual(geometry.viewport);
    expect(geometry.width).toBeLessThanOrEqual(geometry.clientWidth + 1);
    expect(geometry.height).toBeLessThanOrEqual(geometry.clientHeight + 1);
    expect(geometry.scrolling).toBe(0);
    const contrast = await stage.locator('h2,h3,p,li,a').evaluateAll(elements => {
      const rgb = (value: string) => (value.match(/[\d.]+/g) ?? []).slice(0, 3).map(Number);
      const luminance = (c: number[]) => c.map(v => v / 255).map(v => v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4).reduce((sum, v, i) => sum + v * [0.2126, 0.7152, 0.0722][i], 0);
      return elements.map(el => {
        let parent: Element | null = el;
        while (parent && getComputedStyle(parent).backgroundColor === 'rgba(0, 0, 0, 0)') parent = parent.parentElement;
        const [a, b] = [luminance(rgb(getComputedStyle(parent!).backgroundColor)), luminance(rgb(getComputedStyle(el).color))].sort((x, y) => y - x);
        return { label: el.textContent, ratio: (a + 0.05) / (b + 0.05) };
      });
    });
    for (const { label, ratio } of contrast) expect(ratio, `${mode}/${style} ${label}`).toBeGreaterThanOrEqual(4.5);
    if (viewport.width === 1280) {
      await stage.scrollIntoViewIfNeeded();
      await page.screenshot({ path: testInfo.outputPath(`slide-${mode}-${style}.png`) });
    }
  });
}

test('teaching style draws only the explicit arrows from source text', async ({ page }) => {
  await mockSlides(page, '## Slide 1: 原文流程\n\n- 任务失败 → 取消其余任务 → 汇总异常组\n\n- 调用方处理异常。');
  await page.goto(`/ai-research/${jobId}`);
  const stage = page.locator('[data-slide-stage]');
  await expect(stage.getByLabel('原文中的流程')).toHaveCount(1);
  await expect(stage.getByLabel('原文中的流程')).toContainText('任务失败');
  await expect(stage.getByLabel('原文中的流程')).toContainText('取消其余任务');
});
