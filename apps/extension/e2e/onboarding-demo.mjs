import { cp, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { chromium } from '../../web/node_modules/@playwright/test/index.mjs';
import { tempPath } from './temp-paths.mjs';
import assert from 'node:assert/strict';

// The bundled demo article must work without any host permission: opening it
// from the guide produces a readable page, the guide records progress, and the
// platform entry is offered as a secondary link instead of a first-run path.
const extensionPath = `${await mkdtemp(tempPath('reader-onboarding-extension-'))}/extension`;
await cp(new URL('../.output/chrome-mv3', import.meta.url), extensionPath, { recursive: true });
const manifestPath = `${extensionPath}/manifest.json`;
const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
manifest.host_permissions = [...new Set([...(manifest.host_permissions || []), 'http://127.0.0.1/*'])];
await writeFile(manifestPath, JSON.stringify(manifest));

const executablePath = process.env.CHROME_FOR_TESTING || [
  '/Users/shaobo.chen/Library/Caches/ms-playwright/chromium-1234/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
].find(existsSync);

const context = await chromium.launchPersistentContext(tempPath(`reader-onboarding-profile-${Date.now()}`), {
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

try {
  const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
  const extensionId = new URL(worker.url()).host;
  await worker.evaluate(() => { chrome.sidePanel.open = async () => {}; });
  await worker.evaluate(() => chrome.storage.local.set({ readerUiLanguage: 'zh-CN' }));

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

  // 1. A configured model reveals the guide; the platform entry is a text link.
  await panel.locator('#guide-card').waitFor({ state: 'visible', timeout: 10_000 });
  assert.equal(await panel.locator('#guide-demo').isVisible(), true);
  assert.equal(await panel.locator('#empty-platform').isVisible(), true);
  assert.match(await panel.locator('#empty-platform').innerText(), /调研平台/);

  // 2. Opening the demo needs no permission prompt and yields a readable page.
  const demoOpened = context.waitForEvent('page', { predicate: (page) => page.url().endsWith('/demo.html'), timeout: 15_000 });
  await panel.locator('#guide-demo').click();
  const demo = await demoOpened;
  await demo.waitForLoadState('domcontentloaded');
  await demo.waitForSelector('[data-deep-research-dock]', { timeout: 15_000 });
  await panel.waitForFunction(() => document.querySelector('#page-context-status')?.textContent === '正文已读取', null, { timeout: 20_000 });
  const title = await panel.locator('#page-title').innerText();
  assert.match(title, /Bounded queues/, `示例文章标题应出现在侧栏：${title}`);
  assert.equal(await panel.evaluate(async () => (await chrome.storage.local.get('readerGuide')).readerGuide?.demo), true, '打开示例文章应记录引导进度');

  // 3. The demo article translates like a normal page.
  await demo.locator('[data-deep-research-dock] button[data-action="translate"]').click();
  await demo.waitForFunction(() => document.querySelectorAll('[data-deep-research-translation]').length > 0, null, { timeout: 60_000 });
  await panel.waitForFunction(async () => {
    const stored = await chrome.storage.local.get('readerGuide');
    return stored.readerGuide?.translate === true;
  }, null, { timeout: 20_000 });

  // 4. The platform entry switches settings into platform mode. A fresh panel
  // has no page context, so it shows the same first-run surface.
  const fresh = await context.newPage();
  await fresh.goto(`chrome-extension://${extensionId}/sidepanel.html`, { waitUntil: 'domcontentloaded' });
  await fresh.waitForFunction(() => document.documentElement.dataset.readerReady === 'true');
  await fresh.locator('#empty-view').waitFor({ state: 'visible', timeout: 10_000 });
  await fresh.locator('#empty-platform').click();
  await fresh.locator('#settings-view').waitFor({ state: 'visible', timeout: 10_000 });
  assert.equal(await fresh.locator('#mode-platform').getAttribute('aria-pressed'), 'true', '平台入口应切到平台模式');
  assert.equal(await fresh.locator('#platform-settings').isVisible(), true);

  console.log(JSON.stringify({
    ok: true,
    checks: [
      'a configured model reveals the 60-second guide',
      'the platform entry is a secondary link, not a first-run path',
      'the bundled demo opens without any host permission and is readable in the panel',
      'the demo article translates and the guide records progress',
      'the platform link switches settings into platform mode',
    ],
    demoTitle: title,
  }, null, 2));
} finally {
  await context.close();
}
