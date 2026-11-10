import { createServer } from 'node:http';
import { cp, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { chromium } from '../../web/node_modules/@playwright/test/index.mjs';
import { tempPath } from './temp-paths.mjs';
import assert from 'node:assert/strict';

// Use the guide's own buttons, not replacement actions on the page dock.
// The local fixture owns model responses and rejected platform endpoints;
// this test needs neither a running model nor an authenticated platform.
const modelCalls = [];
const platformCalls = [];
const server = createServer(async (request, response) => {
  response.setHeader('access-control-allow-origin', '*');
  response.setHeader('access-control-allow-headers', 'content-type, authorization');
  response.setHeader('access-control-allow-methods', 'GET, POST, OPTIONS');
  if (request.method === 'OPTIONS') { response.writeHead(204); response.end(); return; }
  if (request.url === '/v1/models') {
    response.setHeader('content-type', 'application/json');
    response.end(JSON.stringify({ data: [{ id: 'onboarding-fixture' }] }));
    return;
  }
  let raw = '';
  for await (const chunk of request) raw += chunk;
  const payload = raw ? JSON.parse(raw) : {};
  if (request.url?.startsWith('/api/reading/')) {
    if (request.method === 'POST' && /\/(?:translate|answer)(?:\/|$)/u.test(request.url)) {
      platformCalls.push({ path: request.url, payload });
      response.writeHead(400, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ code: 'VALIDATION_FAILED', message: '原网页阅读只支持 HTTP(S) 页面' }));
    } else {
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify({ items: [], insights: [], sessions: [] }));
    }
    return;
  }
  if (request.url !== '/v1/chat/completions') { response.writeHead(404); response.end(); return; }
  const text = String(payload.messages?.at(-1)?.content || '');
  let content;
  if (text.includes('<<<TRANSLATION_BATCH>>>')) {
    const batch = JSON.parse(text.split('<<<TRANSLATION_BATCH>>>\n')[1]);
    content = JSON.stringify({ translations: batch.blocks.map(({ id, text: source }) => ({ id, text: `译文：${source}` })) });
    modelCalls.push('translation');
  } else if (text.includes('<<<SOURCE_TEXT>>>')) {
    content = `译文：${text.match(/<<<SOURCE_TEXT>>>\n([\s\S]*?)\n<<<END_SOURCE_TEXT>>>/u)?.[1] || ''}`;
    modelCalls.push('translation');
  } else {
    content = JSON.stringify({
      answer: '有界队列使新工作的成本对生产者可见，而不是为了降低性能。',
      evidence: [{ quote: 'The bound is not there to slow the system down; it is there to make the cost of new work visible to the producer.', claim: '限制让新工作的成本可见。' }],
      background: '', inference: '', limitations: [],
    });
    modelCalls.push('answer');
  }
  response.setHeader('content-type', payload.stream ? 'text/event-stream' : 'application/json');
  if (payload.stream) {
    response.write(`data: ${JSON.stringify({ choices: [{ delta: { content }, finish_reason: 'stop' }] })}\n\n`);
    response.end('data: [DONE]\n\n');
  } else {
    response.end(JSON.stringify({ choices: [{ message: { content }, finish_reason: 'stop' }] }));
  }
});
await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
const fixtureOrigin = `http://127.0.0.1:${server.address().port}`;

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

let context;
async function writeSettings(page, values) {
  await page.evaluate(async (settings) => {
    const database = await new Promise((resolve, reject) => {
      const request = indexedDB.open('deep-research-reader', 4);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    await new Promise((resolve, reject) => {
      const transaction = database.transaction('settings', 'readwrite');
      for (const [id, value] of Object.entries(settings)) {
        transaction.objectStore('settings').put({ id, value, updatedAt: new Date().toISOString() });
      }
      transaction.oncomplete = resolve;
      transaction.onerror = () => reject(transaction.error);
    });
    database.close();
  }, values);
}
async function waitReady(page) {
  await page.waitForFunction(() => document.documentElement.dataset.readerReady === 'true');
}
async function waitDemoContext(page) {
  await waitReady(page);
  await page.waitForFunction(() => document.querySelector('#page-context-status')?.textContent === '正文已读取', null, { timeout: 20_000 });
  assert.match(await page.locator('#page-title').innerText(), /Bounded queues/u);
}
try {
  context = await chromium.launchPersistentContext(tempPath(`reader-onboarding-profile-${Date.now()}`), {
    executablePath,
    headless: process.env.READER_HEADLESS === '1',
    viewport: { width: 420, height: 900 },
    args: ['--enable-extensions', `--disable-extensions-except=${extensionPath}`, `--load-extension=${extensionPath}`, '--no-first-run', '--no-default-browser-check'],
  });
  const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
  const extensionId = new URL(worker.url()).host;
  const panelUrl = `chrome-extension://${extensionId}/sidepanel.html`;
  await worker.evaluate(async () => {
    chrome.sidePanel.open = async () => {};
    await chrome.storage.local.set({ readerUiLanguage: 'zh-CN' });
  });
  let panel = await context.newPage();
  await panel.goto(panelUrl, { waitUntil: 'domcontentloaded' });
  await waitReady(panel);
  await writeSettings(panel, { provider: { providerKind: 'custom', baseUrl: `${fixtureOrigin}/v1`, model: 'onboarding-fixture', apiKey: '' } });
  await panel.reload({ waitUntil: 'domcontentloaded' });
  await waitReady(panel);
  await panel.locator('#guide-card').waitFor({ state: 'visible', timeout: 10_000 });
  assert.equal(await panel.locator('#empty-platform').isVisible(), true);

  const demoOpened = context.waitForEvent('page', { predicate: (page) => page.url().endsWith('/demo.html'), timeout: 15_000 });
  await panel.locator('#guide-demo').click();
  const demo = await demoOpened;
  await demo.waitForLoadState('domcontentloaded');
  await waitDemoContext(panel);
  assert.equal(await panel.locator('#guide-translate').isVisible(), true, '步骤 1 完成后，步骤 2 仍须可见');
  assert.equal(await panel.locator('#guide-ask').isVisible(), true, '步骤 1 完成后，步骤 3 仍须可见');
  assert.equal(await panel.evaluate(async () => (await chrome.storage.local.get('readerGuide')).readerGuide?.demo), true);

  const demoTab = await worker.evaluate(async (id) => (await chrome.tabs.query({ url: `chrome-extension://${id}/demo.html` }))[0], extensionId);
  const boundPanelUrl = `${panelUrl}?sourceTab=${demoTab.id}`;
  // A real native side panel does not steal the active tab when clicked. The
  // documented sourceTab harness provides that same binding in this tab UI.
  await demo.bringToFront();
  await panel.goto(boundPanelUrl, { waitUntil: 'domcontentloaded' });
  await waitDemoContext(panel);
  await panel.reload({ waitUntil: 'domcontentloaded' });
  await waitDemoContext(panel);
  await panel.close();
  panel = await context.newPage();
  await demo.bringToFront();
  await panel.goto(boundPanelUrl, { waitUntil: 'domcontentloaded' });
  await waitDemoContext(panel);
  assert.equal(await panel.locator('#guide-translate').isVisible(), true);

  await panel.locator('#guide-translate').click();
  await demo.waitForFunction(() => document.querySelectorAll('[data-deep-research-translation]').length > 0, null, { timeout: 60_000 });
  await panel.waitForFunction(async () => (await chrome.storage.local.get('readerGuide')).readerGuide?.translate === true, null, { timeout: 20_000 });
  assert.ok(modelCalls.includes('translation'));
  await panel.locator('#guide-ask').click();
  assert.match(await panel.locator('#question-input').inputValue(), /有界队列/u);
  await panel.locator('#send-question').click();
  await panel.waitForFunction(async () => (await chrome.storage.local.get('readerGuide')).readerGuide?.ask === true, null, { timeout: 30_000 });
  assert.ok(modelCalls.includes('answer'));
  await panel.locator('#guide-card').waitFor({ state: 'hidden' });
  const completed = await panel.evaluate(async () => (await chrome.storage.local.get('readerGuide')).readerGuide);
  assert.equal(completed.demo && completed.translate && completed.ask, true);

  // A connected platform must not offer the standalone-only demo, or send its
  // extension URL into HTTP(S)-only platform translate/answer endpoints.
  await writeSettings(panel, { readingMode: 'platform', platformUrl: fixtureOrigin });
  await panel.evaluate(async (origin) => chrome.storage.local.set({
    readerToken: 'onboarding-platform-fixture', readerTokenOrigin: origin, readerPlatformUrl: origin,
    readerGuide: { demo: false, translate: false, ask: false, dismissed: false },
  }), fixtureOrigin);
  await panel.reload({ waitUntil: 'domcontentloaded' });
  await waitDemoContext(panel);
  assert.equal(await panel.locator('#guide-card').isVisible(), false, '平台模式不应提供无法调用服务端的示例引导');
  assert.match(await panel.locator('#platform-status').textContent(), /已连接/u);
  const before = platformCalls.length;
  const translate = panel.locator('#chat-translate');
  if (await translate.isEnabled()) await translate.click();
  await panel.locator('#question-input').fill('为什么需要有界队列？');
  const send = panel.locator('#send-question');
  if (await send.isEnabled()) await send.click();
  await panel.waitForTimeout(750);
  assert.equal(platformCalls.length, before, '已打开示例切到平台模式后，不应发送无效 URL 的翻译或提问');
  assert.match(await panel.locator('#notice').textContent(), /示例|独立模式/u);

  console.log(JSON.stringify({ ok: true, checks: [
    'guide steps remain visible after the demo becomes readable',
    'demo context survives panel reload and recreation without injection permission',
    'guide translate and ask buttons complete their persisted steps',
    'connected platform mode hides the demo guide and blocks invalid demo requests',
  ], modelCalls: modelCalls.length, invalidPlatformCalls: platformCalls.length }, null, 2));
} finally {
  await context?.close();
  await new Promise((resolve) => server.close(resolve));
}
