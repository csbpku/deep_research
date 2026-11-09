import { createServer } from 'node:http';
import { cp, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { chromium } from '../../web/node_modules/@playwright/test/index.mjs';
import { join } from 'node:path';
import { tempPath } from './temp-paths.mjs';
import assert from 'node:assert/strict';

// In-page surfaces (dock, image controls, selection translation) must not sit
// on top of article content when the user is not interacting with them.
const root = new URL('..', import.meta.url).pathname;
const fixture = await readFile(new URL('./fixture.html', import.meta.url));
const port = 8897;
const server = createServer((request, response) => {
  if (request.url === '/fixture.html') {
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    response.end(fixture);
    return;
  }
  response.writeHead(404);
  response.end('not found');
});
await new Promise((resolve, reject) => {
  server.once('error', reject);
  server.listen(port, '127.0.0.1', resolve);
});

const extensionPath = `${await mkdtemp(tempPath('reader-overlay-extension-'))}/extension`;
await cp(join(root, '.output/chrome-mv3'), extensionPath, { recursive: true });
const manifestPath = `${extensionPath}/manifest.json`;
const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
manifest.host_permissions = [...new Set([...(manifest.host_permissions || []), 'http://127.0.0.1/*'])];
await writeFile(manifestPath, JSON.stringify(manifest));

const executablePath = process.env.CHROME_FOR_TESTING || [
  '/Users/shaobo.chen/Library/Caches/ms-playwright/chromium-1234/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
].find(existsSync);
if (!executablePath) throw new Error('找不到 Chrome，请设置 CHROME_FOR_TESTING');

const context = await chromium.launchPersistentContext(tempPath(`reader-overlay-profile-${Date.now()}`), {
  executablePath,
  headless: process.env.READER_HEADLESS === '1',
  viewport: { width: 1280, height: 900 },
  args: [
    '--enable-extensions',
    `--disable-extensions-except=${extensionPath}`,
    `--load-extension=${extensionPath}`,
    '--no-first-run',
    '--no-default-browser-check',
  ],
});

const inject = async (worker, article) => {
  await article.bringToFront();
  await worker.evaluate(async () => {
    const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    if (!tab?.id) throw new Error('fixture tab is not active');
    await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['content.js'] });
    await chrome.tabs.sendMessage(tab.id, { type: 'deep-research:request-page' });
  });
};

try {
  const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
  const extensionId = new URL(worker.url()).host;
  await worker.evaluate(() => { chrome.sidePanel.open = async () => {}; });
  await worker.evaluate(() => chrome.storage.local.set({ readerUiLanguage: 'zh-CN' }));

  const article = await context.newPage();
  await article.goto(`http://127.0.0.1:${port}/fixture.html`, { waitUntil: 'domcontentloaded' });
  await inject(worker, article);
  await article.waitForSelector('[data-deep-research-dock]', { timeout: 10_000 });

  // 1. Dock collapses to the chat entry and stays collapsed across reloads.
  const collapse = article.locator('[data-deep-research-dock] button[data-action="collapse"]');
  assert.equal(await collapse.count(), 1, 'dock 应提供收起入口');
  await collapse.click();
  await article.waitForFunction(() => document.querySelector('[data-deep-research-dock]')?.shadowRoot?.querySelector('.dock')?.classList.contains('collapsed'), null, { timeout: 5_000 });
  assert.equal(await worker.evaluate(async () => (await chrome.storage.local.get('readerDockCollapsed')).readerDockCollapsed), true);
  // Hovering or focusing a collapsed dock expands it by design, so the hidden
  // state only holds after the pointer and focus both leave it.
  await article.mouse.move(640, 20);
  await article.evaluate(() => document.activeElement instanceof HTMLElement && document.activeElement.blur());
  await article.waitForTimeout(200);
  const quickHidden = await article.evaluate(() => [...document.querySelector('[data-deep-research-dock]').shadowRoot.querySelectorAll('.quick')]
    .every((button) => getComputedStyle(button).display === 'none'));
  assert.equal(quickHidden, true, '收起后快捷动作应隐藏');

  await article.locator('[data-deep-research-dock]').hover();
  await article.waitForFunction(() => [...document.querySelector('[data-deep-research-dock]').shadowRoot.querySelectorAll('.quick')]
    .some((button) => getComputedStyle(button).display !== 'none'), null, { timeout: 5_000 });
  await article.mouse.move(640, 20);
  await article.waitForTimeout(150);

  await article.reload({ waitUntil: 'domcontentloaded' });
  await inject(worker, article);
  await article.waitForSelector('[data-deep-research-dock]', { timeout: 10_000 });
  await article.waitForFunction(() => document.querySelector('[data-deep-research-dock]')?.shadowRoot?.querySelector('.dock')?.classList.contains('collapsed'), null, { timeout: 5_000 });

  // 2. Image controls stay hidden until the figure is hovered, and sit above
  // the image instead of covering its top-right label. Controls only exist
  // once a figure carries a translation, so apply one directly.
  const imageId = await article.evaluate(() => document.querySelector('[data-deep-research-image]')?.dataset.deepResearchImage || '');
  assert.ok(imageId, '无法读取图片 ID');
  await worker.evaluate(async ({ id }) => {
    const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    await chrome.tabs.sendMessage(tab.id, {
      type: 'deep-research:apply-image-translations',
      translations: [{
        id,
        confidence: 0.95,
        regions: [{ text: 'Bounded Queue', translation: '有界队列', x: 286, y: 22, width: 190, height: 72 }],
        fallbackTranslation: '',
        note: '',
      }],
    });
  }, { id: imageId });
  await article.waitForSelector('[data-deep-research-image-control]', { timeout: 10_000 });
  const control = article.locator('[data-deep-research-image-control]').first();
  assert.equal(await control.count() > 0, true, '图片应有阅读控件');
  assert.equal(await control.evaluate((node) => getComputedStyle(node).opacity), '0', '未悬停时图片控件应隐藏');
  const wrapper = article.locator('[data-deep-research-image-wrap]').first();
  await wrapper.hover();
  await article.waitForFunction(() => {
    const node = document.querySelector('[data-deep-research-image-control]');
    return node && getComputedStyle(node).opacity === '1';
  }, null, { timeout: 5_000 });
  const geometry = await article.evaluate(() => {
    const controlNode = document.querySelector('[data-deep-research-image-control]');
    const imageNode = controlNode?.closest('[data-deep-research-image-wrap]')?.querySelector('img,svg');
    if (!controlNode || !imageNode) return null;
    const controlRect = controlNode.getBoundingClientRect();
    const imageRect = imageNode.getBoundingClientRect();
    return { controlBottom: controlRect.bottom, controlTop: controlRect.top, imageTop: imageRect.top, imageLeft: imageRect.left, imageRight: imageRect.right, opacity: getComputedStyle(controlNode).opacity };
  });
  assert.ok(geometry, '无法测量图片控件');
  assert.ok(geometry.controlBottom <= geometry.imageTop + 1, `图片控件应位于图片上方：${JSON.stringify(geometry)}`);
  await article.mouse.move(20, 860);
  await article.waitForFunction(() => getComputedStyle(document.querySelector('[data-deep-research-image-control]')).opacity === '0', null, { timeout: 5_000 });

  // 3. A short selection translation must not reserve a half-screen panel.
  const panel = await context.newPage();
  await panel.goto(`chrome-extension://${extensionId}/sidepanel.html`, { waitUntil: 'domcontentloaded' });
  await panel.waitForFunction(() => document.documentElement.dataset.readerReady === 'true');
  await panel.evaluate(async () => {
    await new Promise((resolve, reject) => {
      const request = indexedDB.open('deep-research-reader', 4);
      request.onupgradeneeded = () => {
        const database = request.result;
        ['sessions', 'insights', 'annotations', 'settings', 'cache', 'jobs', 'taskInputs']
          .forEach((name) => { if (!database.objectStoreNames.contains(name)) database.createObjectStore(name, { keyPath: 'id' }); });
      };
      request.onsuccess = () => {
        const database = request.result;
        const transaction = database.transaction('settings', 'readwrite');
        transaction.objectStore('settings').put({
          id: 'provider',
          value: { providerKind: 'custom', baseUrl: 'http://127.0.0.1:8799/v1', model: 'gpt-4o-mini', apiKey: '' },
          updatedAt: new Date().toISOString(),
        });
        transaction.oncomplete = () => { database.close(); resolve(); };
        transaction.onerror = () => reject(transaction.error);
      };
      request.onerror = () => reject(request.error);
    });
  });
  await panel.reload({ waitUntil: 'domcontentloaded' });
  await panel.waitForFunction(() => document.documentElement.dataset.readerReady === 'true');
  await inject(worker, article);
  await panel.waitForFunction(() => document.querySelector('#page-context-status')?.textContent === '正文已读取', null, { timeout: 10_000 });

  const selection = await article.evaluate(() => {
    const node = document.querySelector('#target');
    const text = node.firstChild;
    const range = document.createRange();
    range.setStart(text, 0);
    range.setEnd(text, 'Bounded queues keep browser'.length);
    const chosen = window.getSelection();
    chosen.removeAllRanges();
    chosen.addRange(range);
    node.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
    const rect = range.getBoundingClientRect();
    return { top: rect.top, bottom: rect.bottom, left: rect.left, right: rect.right };
  });
  await panel.locator('#selection-section').waitFor({ state: 'visible', timeout: 10_000 });
  await article.keyboard.press('Alt+Shift+t');
  await article.waitForSelector('[data-deep-research-selection-translation]', { timeout: 30_000 });
  await article.waitForTimeout(300);
  const popup = await article.evaluate(() => {
    const node = document.querySelector('[data-deep-research-selection-translation]');
    const rect = node.getBoundingClientRect();
    return {
      height: rect.height,
      top: rect.top,
      bottom: rect.bottom,
      left: rect.left,
      right: rect.right,
      viewport: { width: innerWidth, height: innerHeight },
      text: node.shadowRoot?.querySelector('.text')?.textContent || '',
    };
  });
  assert.ok(popup.height < 220, `一行译文不应占用半屏：${JSON.stringify(popup)}`);
  assert.ok(popup.height > 72, `译文面板应保留最小可读高度：${JSON.stringify(popup)}`);
  assert.ok(popup.top >= -1 && popup.bottom <= popup.viewport.height + 1 && popup.left >= -1 && popup.right <= popup.viewport.width + 1,
    `译文面板应保持在视口内：${JSON.stringify(popup)}`);
  const overlaps = popup.left < selection.right && popup.right > selection.left
    && popup.top < selection.bottom && popup.bottom > selection.top;
  assert.equal(overlaps, false, `译文面板不应遮住所选原文：${JSON.stringify({ popup, selection })}`);

  console.log(JSON.stringify({
    ok: true,
    checks: [
      'dock collapses to the chat entry and the collapsed state persists across page reloads',
      'hovering the collapsed dock restores the quick actions',
      'image controls stay hidden until the figure is hovered and sit above the image',
      'a short selection translation keeps a content-sized panel inside the viewport',
      'the translation panel never covers the selected source text',
    ],
    popupHeight: Math.round(popup.height),
  }, null, 2));
} finally {
  await context.close();
  server.close();
}
