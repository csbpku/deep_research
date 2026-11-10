import { createServer } from 'node:http';
import { cp, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { chromium } from '../../web/node_modules/@playwright/test/index.mjs';
import { join } from 'node:path';
import { tempPath } from './temp-paths.mjs';
import assert from 'node:assert/strict';

// "Ask my library" must answer only from saved items, show the cited records,
// and refuse to guess when nothing matches instead of calling the model.
const root = new URL('..', import.meta.url).pathname;
const fixture = await readFile(new URL('./fixture.html', import.meta.url));
const port = 8901;
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

const extensionPath = `${await mkdtemp(tempPath('reader-library-ask-extension-'))}/extension`;
await cp(join(root, '.output/chrome-mv3'), extensionPath, { recursive: true });
const manifestPath = `${extensionPath}/manifest.json`;
const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
manifest.host_permissions = [...new Set([...(manifest.host_permissions || []), 'http://127.0.0.1/*'])];
await writeFile(manifestPath, JSON.stringify(manifest));

const executablePath = process.env.CHROME_FOR_TESTING || [
  '/Users/shaobo.chen/Library/Caches/ms-playwright/chromium-1234/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
].find(existsSync);

const context = await chromium.launchPersistentContext(tempPath(`reader-library-ask-profile-${Date.now()}`), {
  executablePath,
  headless: process.env.READER_HEADLESS === '1',
  viewport: { width: 400, height: 900 },
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
  await route.fulfill({
    status: 200,
    contentType: 'application/json',
    headers: { 'access-control-allow-origin': '*' },
    body: JSON.stringify({ choices: [{ message: { content: '{"answer":"背压来自生产速度快于消费速度 [1]。","citations":[1]}' } }] }),
  });
});

try {
  const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
  const extensionId = new URL(worker.url()).host;
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
        const transaction = database.transaction(['insights', 'settings'], 'readwrite');
        const insights = transaction.objectStore('insights');
        insights.put({ id: 'bp', url: 'https://example.com/streams', title: '背压与流控', quote: '生产速度快于消费速度时，缓冲区持续增长。', note: '', aiAnswer: '', tags: ['流控'], createdAt: '2026-11-01T00:00:00.000Z', updatedAt: '2026-11-01T00:00:00.000Z' });
        insights.put({ id: 'cache', url: 'https://example.com/cache', title: '缓存失效策略', quote: 'LRU 在突发流量下命中率会下降。', note: '', aiAnswer: '', tags: ['缓存'], createdAt: '2026-11-02T00:00:00.000Z', updatedAt: '2026-11-02T00:00:00.000Z' });
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

  const article = await context.newPage();
  await article.goto(`http://127.0.0.1:${port}/fixture.html`, { waitUntil: 'domcontentloaded' });
  await article.bringToFront();
  await worker.evaluate(async () => {
    const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['content.js'] });
    await chrome.tabs.sendMessage(tab.id, { type: 'deep-research:request-page' });
  });
  await panel.waitForFunction(() => document.querySelector('#page-view') && !document.querySelector('#page-view').classList.contains('hidden'), null, { timeout: 10_000 });
  await panel.locator('#nav-library').click();
  await panel.locator('.insight-row').first().waitFor({ state: 'visible', timeout: 10_000 });

  // 1. A matching question calls the model with only the saved evidence.
  await panel.locator('#library-ask-input').fill('我之前记过哪些关于背压的结论？');
  await panel.locator('#library-ask').click();
  await panel.locator('#library-ask-answer').waitFor({ state: 'visible', timeout: 20_000 });
  const answer = await panel.locator('#library-ask-answer').innerText();
  assert.match(answer, /背压来自生产速度/, `回答应来自模型：${answer}`);
  assert.equal(requests.length, 1, '命中收藏时应只调用一次模型');
  assert.match(requests[0].system, /只依据/, 'system 应约束只依据证据');
  assert.match(requests[0].user, /背压与流控/, '证据应包含命中的收藏标题');
  assert.equal(requests[0].user.includes('缓存失效策略'), false, '不相关的收藏不应进入证据');
  const citations = await panel.locator('#library-ask-citations .library-citation').allInnerTexts();
  assert.equal(citations.length, 1, `应展示一条引用：${JSON.stringify(citations)}`);
  assert.match(citations[0], /背压与流控/);
  assert.match(await panel.locator('#library-ask-status').innerText(), /1 条收藏证据/);

  // 2. A question with no matching saved item must not call the model.
  await panel.locator('#library-ask-input').fill('Kubernetes 调度器亲和性怎么配？');
  await panel.locator('#library-ask').click();
  await panel.waitForFunction(() => document.querySelector('#library-ask-status')?.textContent?.includes('没有匹配'), null, { timeout: 10_000 });
  assert.equal(requests.length, 1, '无命中时不应调用模型');
  assert.equal(await panel.locator('#library-ask-answer').isVisible(), false, '无命中时不应显示旧回答');

  console.log(JSON.stringify({
    ok: true,
    checks: [
      'a matching question sends only the relevant saved items as evidence',
      'the answer cites the saved records and shows citation links',
      'a question with no matching saved item never calls the model',
    ],
    citations,
  }, null, 2));
} finally {
  await context.close();
  server.close();
}
