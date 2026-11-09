import { createServer } from 'node:http';
import { cp, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { chromium } from '../../web/node_modules/@playwright/test/index.mjs';
import { join } from 'node:path';
import { tempPath } from './temp-paths.mjs';
import assert from 'node:assert/strict';

// A site marked "always" translates a newly opened article without a click,
// and the saved glossary travels with the translation request as data. The
// same site marked "never" must not start anything.
const root = new URL('..', import.meta.url).pathname;
const fixture = await readFile(new URL('./fixture.html', import.meta.url));
const port = 8900;
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

const extensionPath = `${await mkdtemp(tempPath('reader-site-rules-extension-'))}/extension`;
await cp(join(root, '.output/chrome-mv3'), extensionPath, { recursive: true });
const manifestPath = `${extensionPath}/manifest.json`;
const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
manifest.host_permissions = [...new Set([...(manifest.host_permissions || []), 'http://127.0.0.1/*'])];
await writeFile(manifestPath, JSON.stringify(manifest));

const executablePath = process.env.CHROME_FOR_TESTING || [
  '/Users/shaobo.chen/Library/Caches/ms-playwright/chromium-1234/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
].find(existsSync);

const context = await chromium.launchPersistentContext(tempPath(`reader-site-rules-profile-${Date.now()}`), {
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

const requests = [];
await context.route('http://127.0.0.1:8799/**', async (route) => {
  const body = JSON.parse(route.request().postData() || '{}');
  const system = String(body.messages?.find((message) => message.role === 'system')?.content || '');
  const user = String(body.messages?.at(-1)?.content || '');
  requests.push({ system, user });
  const batch = system.includes('只返回严格 JSON') && system.includes('"translations"');
  if (batch) {
    const ids = [...user.matchAll(/"id"\s*:\s*"([^"]+)"/gu)].map((match) => match[1]);
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      headers: { 'access-control-allow-origin': '*' },
      body: JSON.stringify({ choices: [{ message: { content: JSON.stringify({ translations: ids.map((id) => ({ id, text: '译文段落' })) }) } }] }),
    });
    return;
  }
  await route.fulfill({
    status: 200,
    contentType: 'application/json',
    headers: { 'access-control-allow-origin': '*' },
    body: JSON.stringify({ choices: [{ message: { content: '译文段落' } }] }),
  });
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
        transaction.objectStore('settings').put({
          id: 'glossary',
          value: 'bounded queue => 有界队列\nbackpressure => 背压',
          updatedAt: new Date().toISOString(),
        });
        transaction.oncomplete = () => { database.close(); resolve(); };
        transaction.onerror = () => reject(transaction.error);
      };
      request.onerror = () => reject(request.error);
    });
    await chrome.storage.local.set({ readerSiteRules: { '127.0.0.1': 'always' } });
  });
  await panel.reload({ waitUntil: 'domcontentloaded' });
  await panel.waitForFunction(() => document.documentElement.dataset.readerReady === 'true');

  const article = await context.newPage();
  await article.goto(`http://127.0.0.1:${port}/fixture.html`, { waitUntil: 'domcontentloaded' });
  await inject(worker, article);

  // 1. The "always" rule starts the translation with no click.
  await article.waitForFunction(() => document.querySelectorAll('[data-deep-research-translation]').length > 0, null, { timeout: 60_000 });
  const translated = await article.evaluate(() => document.querySelectorAll('[data-deep-research-translation]').length);
  assert.ok(translated > 0, '站点标记为总是翻译时应自动应用译文');
  assert.ok(requests.length > 0, '自动翻译应调用模型');

  // 2. The glossary is attached as data on the translation request.
  const withGlossary = requests.find((item) => item.system.includes('"bounded queue" => "有界队列"'));
  assert.ok(withGlossary, `翻译请求应包含术语表；实际 system 片段：${JSON.stringify(requests.map((item) => item.system.slice(-200)))}`);
  assert.match(withGlossary.system, /"backpressure" => "背压"/);
  assert.match(withGlossary.system, /must take priority/i, '术语表说明应要求优先使用给定译法');
  assert.ok(withGlossary.system.length < 20_000, '注入术语表后 prompt 仍应有界');

  // 3. Switching the same site to "never" stops automatic translation.
  const before = requests.length;
  await panel.evaluate(async () => chrome.storage.local.set({ readerSiteRules: { '127.0.0.1': 'never' } }));
  await panel.reload({ waitUntil: 'domcontentloaded' });
  await panel.waitForFunction(() => document.documentElement.dataset.readerReady === 'true');
  await article.reload({ waitUntil: 'domcontentloaded' });
  await inject(worker, article);
  await article.waitForSelector('[data-deep-research-dock]', { timeout: 10_000 });
  await article.waitForTimeout(3_000);
  assert.equal(requests.length, before, `never 规则下不应发起新的翻译请求：${requests.length} vs ${before}`);
  assert.equal(await article.evaluate(() => document.querySelectorAll('[data-deep-research-translation]').length), 0, 'never 规则下不应有译文');

  console.log(JSON.stringify({
    ok: true,
    checks: [
      'a site marked always starts translation without a click',
      'the saved glossary is attached to the translation request as data',
      'the glossary asks the model to prefer the listed renderings',
      'the same site marked never starts nothing',
    ],
    translations: translated,
    requests: requests.length,
  }, null, 2));
} finally {
  await context.close();
  server.close();
}
