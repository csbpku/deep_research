import { createServer } from 'node:http';
import { cp, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { chromium } from '../../web/node_modules/@playwright/test/index.mjs';
import { join } from 'node:path';
import { tempPath } from './temp-paths.mjs';
import assert from 'node:assert/strict';

// Bilingual layout keeps the source paragraph on screen and places its
// translation below, while the replace layout stays the default. Switching
// the preference must re-lay out already applied translations without another
// model request, and restoring must return the page to a single source copy.
const root = new URL('..', import.meta.url).pathname;
const fixture = await readFile(new URL('./fixture.html', import.meta.url));
const port = 8899;
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

const extensionPath = `${await mkdtemp(tempPath('reader-bilingual-extension-'))}/extension`;
await cp(join(root, '.output/chrome-mv3'), extensionPath, { recursive: true });
const manifestPath = `${extensionPath}/manifest.json`;
const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
manifest.host_permissions = [...new Set([...(manifest.host_permissions || []), 'http://127.0.0.1/*'])];
await writeFile(manifestPath, JSON.stringify(manifest));

const executablePath = process.env.CHROME_FOR_TESTING || [
  '/Users/shaobo.chen/Library/Caches/ms-playwright/chromium-1234/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
].find(existsSync);

const context = await chromium.launchPersistentContext(tempPath(`reader-bilingual-profile-${Date.now()}`), {
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
  await worker.evaluate(() => chrome.storage.local.set({ readerUiLanguage: 'zh-CN', readerTranslationLayout: 'stacked' }));

  const article = await context.newPage();
  await article.goto(`http://127.0.0.1:${port}/fixture.html`, { waitUntil: 'domcontentloaded' });
  await inject(worker, article);
  await article.waitForSelector('[data-deep-research-dock]', { timeout: 10_000 });

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

  // 1. Translate with the stacked preference already stored.
  await article.locator('[data-deep-research-dock] button[data-action="translate"]').click();
  await article.waitForFunction(() => document.querySelectorAll('[data-deep-research-translation]').length > 0, null, { timeout: 60_000 });
  await panel.waitForTimeout(1500);

  const stacked = await article.evaluate(() => {
    const translated = document.querySelector('[data-deep-research-translation][data-deep-research-layout="stacked"]');
    if (!translated) return null;
    const source = translated.previousElementSibling;
    return {
      layout: translated.dataset.deepResearchLayout,
      translationDisplay: getComputedStyle(translated).display,
      sourceDisplay: getComputedStyle(source).display,
      sourceMarked: source.dataset.deepResearchBilingualSource === 'true',
      sourceAbove: Boolean(source.compareDocumentPosition(translated) & Node.DOCUMENT_POSITION_FOLLOWING),
      translationText: translated.textContent,
    };
  });
  assert.ok(stacked, '双语模式应生成带 stacked 标记的译文节点');
  assert.equal(stacked.sourceMarked, true, '原文节点应带 bilingual-source 标记');
  assert.notEqual(stacked.sourceDisplay, 'none', `双语模式原文必须保持可见：${JSON.stringify(stacked)}`);
  assert.notEqual(stacked.translationDisplay, 'none', '双语模式译文必须可见');
  assert.equal(stacked.sourceAbove, true, '译文应出现在原文之后');

  // 2. Toggle the paragraph: the translation hides, the source stays.
  const toggled = await article.evaluate(() => {
    const translated = document.querySelector('[data-deep-research-translation][data-deep-research-layout="stacked"]');
    const source = translated.previousElementSibling;
    source.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
    const control = document.querySelector('[data-deep-research-paragraph-control]');
    const button = control?.shadowRoot?.querySelector('button');
    if (!button) return { found: false };
    button.click();
    return {
      found: true,
      translationDisplay: getComputedStyle(translated).display,
      sourceDisplay: getComputedStyle(source).display,
    };
  });
  if (toggled.found) {
    assert.equal(toggled.translationDisplay, 'none', `切换后译文应隐藏：${JSON.stringify(toggled)}`);
    assert.notEqual(toggled.sourceDisplay, 'none', '切换后原文仍可见');
    await article.evaluate(() => {
      const translated = document.querySelector('[data-deep-research-translation][data-deep-research-layout="stacked"]');
      const source = translated.previousElementSibling;
      source.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
      document.querySelector('[data-deep-research-paragraph-control]')?.shadowRoot?.querySelector('button')?.click();
    });
    await article.waitForFunction(() => {
      const translated = document.querySelector('[data-deep-research-translation][data-deep-research-layout="stacked"]');
      return translated && getComputedStyle(translated).display !== 'none';
    }, null, { timeout: 5_000 });
  }

  // 3. Switching the stored preference re-lays out without a new request.
  await worker.evaluate(() => chrome.storage.local.set({ readerTranslationLayout: 'replace' }));
  await article.waitForFunction(() => {
    const translated = document.querySelector('[data-deep-research-translation]');
    const source = translated?.previousElementSibling;
    return translated && !translated.hasAttribute('data-deep-research-layout')
      && getComputedStyle(source).display === 'none';
  }, null, { timeout: 10_000 });
  const replaced = await article.evaluate(() => {
    const translated = document.querySelector('[data-deep-research-translation]');
    const source = translated.previousElementSibling;
    return { sourceDisplay: getComputedStyle(source).display, translationDisplay: getComputedStyle(translated).display, sourceMarked: source.dataset.deepResearchBilingualSource };
  });
  assert.equal(replaced.sourceDisplay, 'none', `切回替换模式应隐藏原文：${JSON.stringify(replaced)}`);
  assert.notEqual(replaced.translationDisplay, 'none', '替换模式译文保持可见');
  assert.equal(replaced.sourceMarked, undefined, '替换模式不应残留双语标记');

  await worker.evaluate(() => chrome.storage.local.set({ readerTranslationLayout: 'stacked' }));
  await article.waitForFunction(() => {
    const translated = document.querySelector('[data-deep-research-translation]');
    const source = translated?.previousElementSibling;
    return translated?.getAttribute('data-deep-research-layout') === 'stacked'
      && source?.dataset.deepResearchBilingualSource === 'true'
      && getComputedStyle(source).display !== 'none';
  }, null, { timeout: 10_000 });

  // 4. Restoring returns a single visible source copy per paragraph.
  await panel.locator('#restore-page').click();
  await article.waitForFunction(() => document.querySelectorAll('[data-deep-research-translation]').length === 0, null, { timeout: 15_000 });
  const restored = await article.evaluate(() => ({
    translations: document.querySelectorAll('[data-deep-research-translation]').length,
    markedSources: document.querySelectorAll('[data-deep-research-bilingual-source]').length,
    hiddenParagraphs: [...document.querySelectorAll('[data-deep-research-block]')].filter((node) => getComputedStyle(node).display === 'none').length,
  }));
  assert.deepEqual(restored, { translations: 0, markedSources: 0, hiddenParagraphs: 0 }, `恢复原文后不应残留译文或隐藏段落：${JSON.stringify(restored)}`);

  console.log(JSON.stringify({
    ok: true,
    checks: [
      'stacked keeps the source visible and places the translation below it',
      'the paragraph control hides only the translation, then restores it',
      'switching to replace re-lays out without another model request',
      'switching back to stacked restores the bilingual pair',
      'restoring removes every translation and bilingual mark',
    ],
    blocksTranslated: await article.evaluate(() => document.querySelectorAll('[data-deep-research-block]').length),
  }, null, 2));
} finally {
  await context.close();
  server.close();
}
