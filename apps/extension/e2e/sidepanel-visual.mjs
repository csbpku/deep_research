import { createServer } from 'node:http';
import { cp, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { chromium } from '../../../apps/web/node_modules/@playwright/test/index.mjs';

const fixturePath = new URL('./fixture.html', import.meta.url);
const port = 8891;
const server = createServer(async (request, response) => {
  if (request.url === '/fixture.html') {
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    response.end(await readFile(fixturePath));
    return;
  }
  response.writeHead(404);
  response.end('not found');
});
await new Promise((resolve, reject) => {
  server.once('error', reject);
  server.listen(port, '127.0.0.1', resolve);
});

const extensionPath = new URL('../.output/chrome-mv3', import.meta.url).pathname;
const testExtensionRoot = await mkdtemp('/private/tmp/deep-research-reader-visual-extension-');
const testExtensionPath = `${testExtensionRoot}/extension`;
await cp(extensionPath, testExtensionPath, { recursive: true });
const testManifestPath = `${testExtensionPath}/manifest.json`;
const testManifest = JSON.parse(await readFile(testManifestPath, 'utf8'));
testManifest.host_permissions = [...new Set([...(testManifest.host_permissions || []), 'http://127.0.0.1/*'])];
await writeFile(testManifestPath, JSON.stringify(testManifest));
const executablePath = process.env.CHROME_FOR_TESTING
  || [
    '/Users/shaobo.chen/Library/Caches/ms-playwright/chromium-1234/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  ].find(existsSync);
if (!executablePath) throw new Error('找不到 Chrome，请设置 CHROME_FOR_TESTING');

const context = await chromium.launchPersistentContext(`/private/tmp/deep-research-reader-visual-${Date.now()}`, {
  executablePath,
  headless: process.env.READER_HEADLESS === '1',
  viewport: { width: 1280, height: 900 },
  args: [
    '--enable-extensions',
    `--disable-extensions-except=${testExtensionPath}`,
    `--load-extension=${testExtensionPath}`,
    '--no-first-run',
    '--no-default-browser-check',
  ],
});

async function layoutReport(page, name) {
  const report = await page.evaluate((stateName) => {
    const visible = (element) => {
      const style = getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      return style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 0 && rect.height > 0;
    };
    const clippedControls = [...document.querySelectorAll('button,input,select,textarea')]
      .filter(visible)
      .flatMap((element) => {
        const rect = element.getBoundingClientRect();
        const horizontalClip = rect.left < -0.5 || rect.right > innerWidth + 0.5;
        const textClip = element instanceof HTMLButtonElement
          && (element.scrollWidth > element.clientWidth + 1 || element.scrollHeight > element.clientHeight + 1);
        return horizontalClip || textClip
          ? [{ id: element.id || element.textContent?.trim() || element.tagName, rect: { left: rect.left, right: rect.right, width: rect.width }, horizontalClip, textClip }]
          : [];
      });
    return {
      state: stateName,
      viewport: { width: innerWidth, height: innerHeight },
      documentWidth: document.documentElement.scrollWidth,
      bodyWidth: document.body.scrollWidth,
      overflowX: document.documentElement.scrollWidth > innerWidth + 1 || document.body.scrollWidth > innerWidth + 1,
      clippedControls,
    };
  }, name);
  if (report.overflowX || report.clippedControls.length > 0) {
    throw new Error(`visual layout assertion failed: ${JSON.stringify(report)}`);
  }
  return report;
}

try {
  const serviceWorker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
  const extensionId = new URL(serviceWorker.url()).host;
  const article = await context.newPage();
  await article.goto(`http://127.0.0.1:${port}/fixture.html`, { waitUntil: 'domcontentloaded' });
  await article.bringToFront();
  await serviceWorker.evaluate(async () => {
    const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    if (!tab?.id) throw new Error('fixture tab is not active');
    await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['content.js'] });
    await chrome.tabs.sendMessage(tab.id, { type: 'deep-research:request-page' });
  });
  await article.waitForSelector('[data-deep-research-dock]', { timeout: 10_000 });
  await article.screenshot({ path: '/private/tmp/deep-research-reader-right-dock.png' });

  const panel = await context.newPage();
  await panel.goto(`chrome-extension://${extensionId}/sidepanel.html`, { waitUntil: 'domcontentloaded' });
  await panel.waitForFunction(() => document.documentElement.dataset.readerReady === 'true', null, { timeout: 10_000 });

  await panel.setViewportSize({ width: 320, height: 820 });
  await panel.locator('#settings-button').click();
  await panel.screenshot({ path: '/private/tmp/deep-research-reader-settings-local-320.png', fullPage: true });
  const local320 = await layoutReport(panel, 'settings-local-320');

  await panel.setViewportSize({ width: 360, height: 820 });
  await panel.locator('#mode-platform').click();
  await panel.screenshot({ path: '/private/tmp/deep-research-reader-settings-platform-360.png', fullPage: true });
  const platform360 = await layoutReport(panel, 'settings-platform-360');

  await panel.locator('#close-settings').click();
  await article.bringToFront();
  await article.evaluate(() => {
    const node = document.querySelector('#target');
    if (!node) throw new Error('fixture target paragraph is missing');
    const range = document.createRange();
    range.selectNodeContents(node);
    const selection = window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);
    node.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
  });
  await panel.waitForFunction(() => Boolean(document.querySelector('#selection-quote')?.textContent), null, { timeout: 10_000 });
  await panel.setViewportSize({ width: 420, height: 820 });
  await panel.screenshot({ path: '/private/tmp/deep-research-reader-article-420.png', fullPage: true });
  const article420 = await layoutReport(panel, 'article-selection-420');
  await panel.locator('#ask-selection').click();
  await panel.locator('#discussion-section').waitFor({ state: 'visible', timeout: 5_000 });
  await panel.locator('#question-input').waitFor({ state: 'visible', timeout: 5_000 });
  await panel.screenshot({ path: '/private/tmp/deep-research-reader-chat-420.png', fullPage: true });
  await panel.screenshot({ path: '/private/tmp/deep-research-reader-chat-420-viewport.png' });
  const pinnedComposer = await panel.locator('#persistent-composer').evaluate((element) => {
    const style = getComputedStyle(element);
    const rect = element.getBoundingClientRect();
    return {
      position: style.position,
      bottomGap: innerHeight - rect.bottom,
      visible: style.display !== 'none' && rect.width > 0 && rect.height > 0,
    };
  });
  const composerOverlap = await panel.locator('#discussion-section').evaluate((section) => {
    const composer = document.querySelector('#persistent-composer')?.getBoundingClientRect();
    const protectedNodes = [...section.querySelectorAll('.chat-window,.chat-scope-bar')]
      .map((element) => element.getBoundingClientRect())
      .filter((rect) => rect.width > 0 && rect.height > 0);
    if (!composer) return { overlaps: false, protectedNodes: [] };
    const overlaps = protectedNodes.some((rect) => (
      composer.left < rect.right
      && composer.right > rect.left
      && composer.top < rect.bottom
      && composer.bottom > rect.top
    ));
    return { overlaps, protectedNodes: protectedNodes.map((rect) => ({ top: rect.top, bottom: rect.bottom })) };
  });
  if (pinnedComposer.position !== 'fixed' || Math.abs(pinnedComposer.bottomGap) > 1 || !pinnedComposer.visible) {
    throw new Error(`chat composer is not fixed at the viewport bottom and visible: ${JSON.stringify(pinnedComposer)}`);
  }
  if (composerOverlap.overlaps) {
    throw new Error(`chat composer overlaps the active chat surface: ${JSON.stringify(composerOverlap)}`);
  }

  const dock = await article.locator('[data-deep-research-dock]').evaluate((element) => {
    const rect = element.getBoundingClientRect();
    return {
      rightGap: innerWidth - rect.right,
      top: rect.top,
      width: rect.width,
      withinViewport: rect.left >= 0 && rect.right <= innerWidth && rect.top >= 0 && rect.bottom <= innerHeight,
    };
  });
  if (!dock.withinViewport || dock.rightGap < -0.5) throw new Error(`right dock is outside the viewport: ${JSON.stringify(dock)}`);

  await panel.setViewportSize({ width: 320, height: 820 });
  await panel.locator('#open-history-header').click();
  await panel.waitForURL(`chrome-extension://${extensionId}/reading-history.html?surface=sidepanel`);
  await panel.screenshot({ path: '/private/tmp/deep-research-reader-history-320.png', fullPage: true });
  const history320 = await layoutReport(panel, 'history-320');
  const historyBackTop = await panel.locator('#close-history').evaluate((element) => element.getBoundingClientRect().top);
  if (historyBackTop > 100) throw new Error('history back action is not in the header');
  const historyActionHeights = await panel.locator('.history-header-actions button').evaluateAll((buttons) => buttons.map((button) => button.getBoundingClientRect().height));
  if (historyActionHeights.some((height) => height > 42)) throw new Error(`history header actions wrap at 320px: ${historyActionHeights}`);
  await panel.locator('#close-history').click();
  await panel.waitForURL(`chrome-extension://${extensionId}/sidepanel.html`);

  console.log(JSON.stringify({
    ok: true,
    extensionId,
    states: [local320, platform360, article420, history320],
    pinnedComposer,
    composerOverlap,
    dock,
    screenshots: [
      '/private/tmp/deep-research-reader-right-dock.png',
      '/private/tmp/deep-research-reader-settings-local-320.png',
      '/private/tmp/deep-research-reader-settings-platform-360.png',
      '/private/tmp/deep-research-reader-article-420.png',
      '/private/tmp/deep-research-reader-chat-420.png',
      '/private/tmp/deep-research-reader-chat-420-viewport.png',
      '/private/tmp/deep-research-reader-history-320.png',
    ],
  }, null, 2));
} finally {
  await context.close();
  await new Promise((resolve) => server.close(resolve));
}
