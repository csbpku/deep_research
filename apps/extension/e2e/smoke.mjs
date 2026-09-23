import { createServer } from 'node:http';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { chromium } from '../../web/node_modules/@playwright/test/index.mjs';

const extensionPath = new URL('../.output/chrome-mv3', import.meta.url).pathname;
const liveMode = process.env.READER_LIVE === '1';
const textOnlyMode = process.env.READER_LIVE_TEXT_ONLY === '1';
const providerUrl = process.env.READER_LIVE_BASE_URL || 'http://127.0.0.1:8799/v1';
const providerModel = process.env.READER_LIVE_MODEL || 'fake-reader';
const visionModel = process.env.READER_LIVE_VISION_MODEL || 'fake-vision';
const providerKey = process.env.READER_LIVE_API_KEY || 'test-key';
if (liveMode && (!process.env.READER_LIVE_BASE_URL || !process.env.READER_LIVE_MODEL || !process.env.READER_LIVE_VISION_MODEL || !process.env.READER_LIVE_API_KEY)) {
  throw new Error('live-provider smoke 需要 READER_LIVE_BASE_URL、READER_LIVE_MODEL、READER_LIVE_VISION_MODEL 和 READER_LIVE_API_KEY；不会回退到假模型');
}
const fixtureUrl = process.env.READER_E2E_URL || 'http://127.0.0.1:8765/fixture.html';
const fixturePath = new URL('./fixture.html', import.meta.url);
const defaultFixtureUrl = 'http://127.0.0.1:8765/fixture.html';
let fixtureServer = null;
if (fixtureUrl === defaultFixtureUrl) {
  fixtureServer = createServer(async (_request, response) => {
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    response.end(await readFile(fixturePath));
  });
  await new Promise((resolve, reject) => {
    fixtureServer.once('error', reject);
    fixtureServer.listen(8765, '127.0.0.1', resolve);
  });
}
const profilePath = process.env.READER_E2E_PROFILE || `/private/tmp/deep-research-reader-e2e-${Date.now()}`;
const executablePath = process.env.CHROME_FOR_TESTING
  || [
    '/Users/shaobo.chen/Library/Caches/ms-playwright/chromium-1234/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  ].find(existsSync);

if (!executablePath) throw new Error('找不到 Chrome，请设置 CHROME_FOR_TESTING');

const context = await chromium.launchPersistentContext(profilePath, {
  executablePath,
  headless: process.env.READER_HEADLESS === '1',
  viewport: { width: 1280, height: 900 },
  args: [
    '--enable-extensions',
    `--disable-extensions-except=${extensionPath}`,
    `--load-extension=${extensionPath}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-popup-blocking',
  ],
});

try {
  await new Promise((resolve) => setTimeout(resolve, 900));
  const serviceWorker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
  const extensionId = new URL(serviceWorker.url()).host;
  const fixture = await context.newPage();
  await fixture.goto(fixtureUrl, { waitUntil: 'domcontentloaded' });
  const panel = await context.newPage();
  await panel.goto(`chrome-extension://${extensionId}/sidepanel.html`, { waitUntil: 'domcontentloaded' });
  await fixture.bringToFront();

  const activation = await serviceWorker.evaluate(async () => {
    const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    if (!tab?.id || tab.windowId === undefined) throw new Error('fixture tab not active');
    await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['content.js'] });
    // Playwright cannot synthesize Chrome's toolbar gesture for
    // sidePanel.open(). The native side-panel gesture is covered by the
    // interactive smoke run; this script keeps the extension page open
    // directly so the content/image protocol can be asserted deterministically.
    try { await chrome.sidePanel.open({ windowId: tab.windowId }); } catch { /* gesture unavailable in automation */ }
    await chrome.tabs.sendMessage(tab.id, { type: 'deep-research:request-page' });
    return { tabId: tab.id, windowId: tab.windowId };
  });
  await panel.waitForTimeout(900);
  const pageDockPresent = await fixture.evaluate(() => Boolean(document.querySelector('[data-deep-research-dock]')));
  if (!pageDockPresent) throw new Error('网页右侧 Reader 入口未注入');

  await panel.locator('#settings-button').click();
  await panel.locator('#provider-kind').selectOption('custom');
  await panel.locator('#provider-url').fill(providerUrl);
  await panel.locator('#provider-model').fill(providerModel);
  await panel.locator('#provider-key').fill(providerKey);
  if (!liveMode || process.env.READER_LIVE_REQUEST_ORIGIN === '0') await panel.locator('#request-provider-origin').uncheck();
  await panel.locator('#save-settings').click();
  await panel.locator('#settings-notice').waitFor({ state: 'visible', timeout: 10_000 });
  const settingsNotice = await panel.locator('#settings-notice').innerText();
  if (!settingsNotice.includes('连接成功')) throw new Error(`模型配置失败：${settingsNotice}`);
  await panel.locator('#close-settings').click();

  // Verify the local selection/evidence loop before starting the long task:
  // the exact source quote is selected in the page, the side panel receives
  // it, and an evidence jump is confirmed by the content script.
  const selectedQuote = await fixture.evaluate(() => {
    const node = document.querySelector('#target');
    if (!node) return '';
    const range = document.createRange();
    range.selectNodeContents(node);
    const selection = window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);
    node.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
    return (node.textContent || '').trim();
  });
  await panel.locator('#selection-section').waitFor({ state: 'visible', timeout: 10_000 });
  await serviceWorker.evaluate(async ({ tabId, quote }) => {
    await chrome.tabs.sendMessage(tabId, { type: 'deep-research:focus-anchor', anchor: { quote } });
  }, { tabId: activation.tabId, quote: selectedQuote });
  await panel.waitForFunction(() => document.querySelector('#notice')?.textContent?.includes('已回到原文证据'), null, { timeout: 5_000 });
  // Keyboard navigation is a first-class reading path: Alt+Shift+Q opens
  // discussion for the current selection without changing the page scroll.
  await fixture.keyboard.press('Alt+Shift+q');
  await panel.locator('#discussion-section').waitFor({ state: 'visible', timeout: 5_000 });
  if (!(await panel.locator('#discussion-context').innerText()).includes('当前选段')) {
    throw new Error('选段快捷键没有保留当前讨论上下文');
  }

  if (textOnlyMode) {
    // A text-model acceptance run must not be blocked by the fixture's image
    // requests. Remove visual candidates and request a fresh page snapshot so
    // this run measures the actual text translation and explanation path.
    await fixture.evaluate(() => document.querySelectorAll('img,svg').forEach((node) => node.remove()));
    await panel.locator('#translate-all').click();
    await panel.waitForFunction(() => {
      const value = document.querySelector('#text-progress-value')?.textContent || '';
      return /\d+ \/ \d+/u.test(value) && !value.startsWith('0 /');
    }, null, { timeout: 30_000 });
    await panel.waitForFunction(() => document.querySelector('#notice')?.textContent?.includes('全文翻译完成'), null, { timeout: 60_000 });
    const textState = await fixture.evaluate(() => ({
      textTranslations: document.querySelectorAll('[data-deep-research-translation]').length,
      codeTranslation: document.querySelector('pre')?.nextElementSibling?.hasAttribute('data-deep-research-translation') || false,
    }));
    if (textState.textTranslations < 1 || textState.codeTranslation) {
      throw new Error(`真实文本翻译断言失败：${JSON.stringify(textState)}`);
    }
    await panel.locator('#explain-selection').click();
    await panel.waitForFunction(() => {
      const text = document.querySelector('#answer-output')?.textContent?.trim() || '';
      return text.length > 20 && !text.includes('正在整理回答');
    }, null, { timeout: 60_000 });
    await panel.locator('#restore-page').click();
    await fixture.waitForSelector('[data-deep-research-translation]', { state: 'detached', timeout: 5_000 });
    console.log(JSON.stringify({ mode: 'live-text-provider', extensionId, activation, settingsNotice, textState }, null, 2));
  } else {
  await panel.locator('#translate-all').click();
  await panel.locator('#image-progress-value').waitFor({ state: 'visible', timeout: 10_000 });
  const imageProgressTimeout = liveMode
    ? Number(process.env.READER_LIVE_IMAGE_TIMEOUT_MS || 120_000)
    : 20_000;
  await panel.waitForFunction(() => document.querySelector('#image-progress-value')?.textContent === '2 / 2', null, { timeout: imageProgressTimeout });
  try {
    await fixture.waitForSelector('[data-deep-research-image-overlay], [data-deep-research-image-fallback], [data-deep-research-image-side-translations] [data-deep-research-image-side-translation]', { timeout: 20_000 });
  } catch (error) {
    const diagnostic = await fixture.evaluate(() => ({
      overlays: document.querySelectorAll('[data-deep-research-image-overlay]').length,
      fallbacks: document.querySelectorAll('[data-deep-research-image-fallback]').length,
      sideWrappers: document.querySelectorAll('[data-deep-research-image-side-translations]').length,
      sideTranslations: document.querySelectorAll('[data-deep-research-image-side-translations] [data-deep-research-image-side-translation]').length,
      wrappers: document.querySelectorAll('[data-deep-research-image-wrap]').length,
    }));
    const panelDiagnostic = await panel.evaluate(() => ({
      notice: document.querySelector('#notice')?.textContent || '',
      settingsNotice: document.querySelector('#settings-notice')?.textContent || '',
      progress: document.querySelector('#progress-area')?.textContent || '',
      failures: document.querySelector('#translation-failures')?.textContent || '',
    }));
    const workerCapabilities = await serviceWorker.evaluate(() => ({
      offscreenCanvas: typeof globalThis.OffscreenCanvas,
      createImageBitmap: typeof globalThis.createImageBitmap,
    })).catch(() => ({}));
    throw new Error(`图片翻译没有产生覆盖或旁侧译文：${JSON.stringify({ diagnostic, panelDiagnostic, workerCapabilities })}; ${error.message}`);
  }

  const translationState = await fixture.evaluate(() => ({
    overlays: document.querySelectorAll('[data-deep-research-image-overlay]').length,
    wrappers: document.querySelectorAll('[data-deep-research-image-wrap]').length,
    fallbacks: document.querySelectorAll('[data-deep-research-image-fallback]').length,
    sideWrappers: document.querySelectorAll('[data-deep-research-image-side-translations]').length,
    sideTranslations: document.querySelectorAll('[data-deep-research-image-side-translations] [data-deep-research-image-side-translation]').length,
    textTranslations: document.querySelectorAll('[data-deep-research-translation]').length,
    translatedLabel: document.body.innerText.includes('有界队列'),
    codeTranslation: document.querySelector('pre')?.nextElementSibling?.hasAttribute('data-deep-research-translation') || false,
  }));
  const validImageResults = translationState.overlays + translationState.fallbacks + translationState.sideWrappers;
  const expectedLiveImageResults = liveMode ? 1 : 2;
  if (translationState.wrappers !== validImageResults || translationState.codeTranslation
    || (liveMode
      ? translationState.textTranslations < 1 || validImageResults < expectedLiveImageResults
      : validImageResults !== 2 || !translationState.translatedLabel)) {
    const failureDetails = await panel.evaluate(() => ({
      notice: document.querySelector('#notice')?.textContent || '',
      progress: document.querySelector('#progress-area')?.textContent || '',
      failures: document.querySelector('#translation-failures')?.textContent || '',
    }));
    throw new Error(`图片/代码翻译断言失败：${JSON.stringify({ translationState, failureDetails })}`);
  }

  const overlayWrap = fixture.locator('[data-deep-research-image-wrap]').filter({
    has: fixture.locator('[data-deep-research-image-overlay]'),
  }).first();
  if (await overlayWrap.count()) {
    const imageControl = overlayWrap.locator('[data-deep-research-image-control]');
    await imageControl.locator('button[data-action="toggle"]').click();
    const originalState = await overlayWrap.locator('[data-deep-research-image-overlay]').evaluate((node) => getComputedStyle(node).display);
    if (originalState !== 'none') throw new Error(`原图切换失败：overlay display=${originalState}`);
    await imageControl.locator('button[data-action="toggle"]').click();
    await imageControl.locator('button[data-action="zoom"]').click();
    await fixture.waitForSelector('[data-deep-research-image-zoom]', { timeout: 5_000 });
    await fixture.keyboard.press('Escape');
    await fixture.waitForSelector('[data-deep-research-image-zoom]', { state: 'detached', timeout: 5_000 });
  } else if (translationState.fallbacks + translationState.sideTranslations < 1) {
    throw new Error('没有原位覆盖，也没有旁侧译文结果');
  }

  const imageControl = fixture.locator('[data-deep-research-image-control]').first();
  await imageControl.locator('button[data-action="explain"]').click();
  await panel.locator('#image-section').waitFor({ state: 'visible', timeout: 5_000 });
  await panel.locator('#explain-image').click();
  if (liveMode) {
    await panel.waitForFunction(() => {
      const text = document.querySelector('#answer-output')?.textContent?.trim() || '';
      return text.length > 20 && !text.includes('正在读取图示');
    }, null, { timeout: 30_000 });
  } else {
    await panel.waitForFunction(() => document.querySelector('#answer-output')?.textContent?.includes('图示展示了'), null, { timeout: 20_000 });
  }

  await panel.locator('#restore-page').click();
  await fixture.waitForSelector('[data-deep-research-image-wrap]', { state: 'detached', timeout: 5_000 });
  const restored = await fixture.evaluate(() => ({
    overlays: document.querySelectorAll('[data-deep-research-image-overlay]').length,
    sideTranslations: document.querySelectorAll('[data-deep-research-image-side-translations]').length,
    wrappers: document.querySelectorAll('[data-deep-research-image-wrap]').length,
    svg: document.querySelector('#architecture-diagram') !== null,
    raster: document.querySelector('#raster-diagram') !== null,
    textTranslations: document.querySelectorAll('[data-deep-research-translation]').length,
  }));
  if (restored.overlays !== 0 || restored.sideTranslations !== 0 || restored.wrappers !== 0 || !restored.svg || !restored.raster || restored.textTranslations !== 0) {
    throw new Error(`恢复原文断言失败：${JSON.stringify(restored)}`);
  }

    console.log(JSON.stringify({ mode: liveMode ? 'live-provider' : 'fake-provider', extensionId, activation, pageDockPresent, settingsNotice, translationState, restored }, null, 2));
  }
} finally {
  await context.close();
  if (fixtureServer) await new Promise((resolve) => fixtureServer.close(resolve));
}
