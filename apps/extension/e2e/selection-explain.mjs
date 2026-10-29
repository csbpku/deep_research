import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { existsSync } from 'node:fs';
import { cp, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { chromium, expect } from '../../web/node_modules/@playwright/test/index.mjs';
import { tempDir } from './temp-paths.mjs';

const calls = [];
const saves = [];
let rejectNext = false;
const server = createServer(async (request, response) => {
  response.setHeader('access-control-allow-origin', '*');
  response.setHeader('access-control-allow-headers', 'content-type, authorization');
  if (request.method === 'OPTIONS') { response.writeHead(204); response.end(); return; }
  if (request.url === '/article') {
    response.setHeader('content-type', 'text/html; charset=utf-8');
    response.end('<html lang="en"><title>Selection fixture</title><main><article><h1>Bounded work</h1><p id="first">A bounded queue keeps browser work responsive.</p><p id="second">Cancellation stops stale requests before they consume model capacity.</p></article></main></html>');
    return;
  }
  if (request.url === '/api/reading/answer/stream') {
    let raw = '';
    for await (const chunk of request) raw += chunk;
    const input = JSON.parse(raw);
    calls.push(input);
    const { body, selection } = input.context;
    const valid = selection?.quote === body.slice(selection.startOffset, selection.endOffset)
      && selection.contentHash === createHash('sha256').update(body).digest('hex');
    if (!valid || rejectNext) {
      rejectNext = false;
      response.writeHead(400, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ code: 'VALIDATION_FAILED', message: '原文摘录与锚点位置不一致，请重新选择原文', requestId: 'selection-validation-test' }));
      return;
    }
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    response.write('event: delta\ndata: {"text":"正在解释选段"}\n\n');
    setTimeout(() => response.end(`event: done\ndata: ${JSON.stringify({ reading: {
      answer: '有界队列与取消机制共同限制过期工作。', evidence: [{ quote: selection.quote, claim: '原文描述队列与取消机制。' }],
      background: '', inference: '', limitations: [], warnings: [],
    } })}\n\n`), 300);
    return;
  }
  if (request.url === '/api/reading/save') {
    let raw = '';
    for await (const chunk of request) raw += chunk;
    saves.push(JSON.parse(raw));
    response.writeHead(201, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ ok: true, draft: { id: '10000000-0000-4000-8000-000000000001' } }));
    return;
  }
  response.writeHead(200, { 'content-type': 'application/json' });
  response.end(JSON.stringify({ ok: true, sessions: [], insights: [] }));
});
await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
const origin = `http://127.0.0.1:${server.address().port}`;
const root = await mkdtemp(join(tempDir(), 'reader-selection-explain-'));
const extensionPath = join(root, 'extension');
await cp(new URL('../.output/chrome-mv3', import.meta.url), extensionPath, { recursive: true });
const manifestPath = join(extensionPath, 'manifest.json');
const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
manifest.host_permissions = [...new Set([...(manifest.host_permissions || []), 'http://127.0.0.1/*'])];
await writeFile(manifestPath, JSON.stringify(manifest));
const executablePath = process.env.CHROME_FOR_TESTING || [
  '/Users/shaobo.chen/Library/Caches/ms-playwright/chromium-1234/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
].find(existsSync);
assert.ok(executablePath, 'Set CHROME_FOR_TESTING to an installed Chrome binary');
const browser = await chromium.launchPersistentContext(join(root, 'profile'), {
  executablePath, headless: true, viewport: { width: 1280, height: 900 },
  args: ['--enable-extensions', `--disable-extensions-except=${extensionPath}`, `--load-extension=${extensionPath}`, '--no-first-run', '--no-default-browser-check'],
});

let testedPanel;
try {
  const worker = browser.serviceWorkers()[0] || await browser.waitForEvent('serviceworker');
  const extensionId = new URL(worker.url()).host;
  // Playwright represents the side panel as a bound extension tab. Opening
  // Chrome's native panel as well creates a second reader that can consume
  // the same selection action and race this test for the answer worker.
  // The native-opener call itself is covered by ui-regressions.test.mjs.
  await worker.evaluate(() => { chrome.sidePanel.open = async () => {}; });
  const article = await browser.newPage();
  await article.goto(`${origin}/article`);
  await article.bringToFront();
  const tabId = await worker.evaluate(async () => {
    const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['content.js'] });
    return tab.id;
  });
  const panel = await browser.newPage();
  const panelUrl = `chrome-extension://${extensionId}/sidepanel.html?sourceTab=${tabId}`;
  await panel.goto(panelUrl);
  await panel.waitForFunction(() => document.documentElement.dataset.readerReady === 'true');
  // Seed the already-authenticated platform settings; PKCE has a separate E2E.
  await panel.evaluate(async origin => {
    const database = await new Promise((resolve, reject) => {
      const open = indexedDB.open('deep-research-reader', 4);
      open.onsuccess = () => resolve(open.result); open.onerror = () => reject(open.error);
    });
    const transaction = database.transaction('settings', 'readwrite');
    for (const [id, value] of Object.entries({ readingMode: 'platform', platformUrl: origin })) transaction.objectStore('settings').put({ id, value });
    await new Promise((resolve, reject) => { transaction.oncomplete = resolve; transaction.onerror = () => reject(transaction.error); });
    database.close();
    await chrome.storage.local.set({ readerToken: 'selection-e2e-token', readerPlatformUrl: origin, readerTokenOrigin: origin, readerUiLanguage: 'zh-CN' });
  }, origin);
  await panel.close();
  await article.bringToFront();
  await worker.evaluate(() => {
    chrome.runtime.onMessage.addListener(message => {
      if (message.type === 'deep-research:from-page' && message.payload?.type === 'deep-research:selection') globalThis.readerSelectionTestContext = message.payload.context;
    });
  });
  await article.evaluate(() => {
    const range = document.createRange();
    range.setStartBefore(document.querySelector('#first'));
    range.setEndAfter(document.querySelector('#second'));
    const selection = window.getSelection(); selection.removeAllRanges(); selection.addRange(range);
    document.querySelector('#second').dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
  });
  await article.locator('[data-deep-research-toolbar]').waitFor();
  await expect.poll(() => worker.evaluate(() => Boolean(globalThis.readerSelectionTestContext?.selection?.quote))).toBe(true);
  const selectedContext = await worker.evaluate(() => globalThis.readerSelectionTestContext);
  assert.ok(selectedContext.selection.quote.includes('\n\n'));
  // Replay the action into a cold panel while its persisted settings load.
  await worker.evaluate(async ({ tabId, context }) => {
    await chrome.storage.session.set({ readerPendingSelectionAction: {
      type: 'deep-research:selection-action', tabId, context, action: 'explain', actionId: 'cold-selection-action', createdAt: Date.now(),
    } });
  }, { tabId, context: selectedContext });
  const reopened = await browser.newPage();
  testedPanel = reopened;
  await reopened.setViewportSize({ width: 420, height: 900 });
  await reopened.addInitScript(() => {
    const read = chrome.storage.local.get.bind(chrome.storage.local);
    chrome.storage.local.get = async keys => {
      if (Array.isArray(keys) && keys.includes('readerToken') && !window.readerSettingsReleased) {
        window.readerSettingsLoading = true;
        await new Promise(resolve => { window.releaseReaderSettings = () => { window.readerSettingsReleased = true; resolve(); }; });
      }
      return read(keys);
    };
  });
  await reopened.goto(panelUrl);
  await reopened.waitForFunction(() => window.readerSettingsLoading);
  await worker.evaluate(async ({ tabId, context }) => {
    await chrome.runtime.sendMessage({ type: 'deep-research:selection-action', tabId, context, action: 'explain', actionId: 'cold-selection-action' });
  }, { tabId, context: selectedContext });
  assert.equal(calls.length, 0, 'An action arriving during settings loading must wait');
  assert.ok(await worker.evaluate(async () => (await chrome.storage.session.get('readerPendingSelectionAction')).readerPendingSelectionAction));
  await reopened.evaluate(() => window.releaseReaderSettings());
  await reopened.waitForFunction(() => document.querySelector('#conversation-list')?.textContent?.includes('有界队列与取消机制'));
  assert.equal(calls.length, 1, 'A cold-panel action should submit exactly one request');
  assert.equal(calls[0].action, 'explain');
  assert.equal(calls[0].context.scope, 'selection');
  assert.ok((await reopened.locator('#conversation-list').innerText()).includes('解释当前选段'));
  assert.equal(await reopened.locator('#question-input').inputValue(), '');

  await reopened.locator('#save-selection').click();
  await reopened.locator('#save-dialog').waitFor({ state: 'visible' });
  assert.equal(await reopened.locator('#save-include-ai').isChecked(), true);
  await reopened.locator('#save-include-ai').uncheck();
  await reopened.locator('#save-sync').uncheck();
  await reopened.locator('#save-note').fill('Only my note');
  await reopened.screenshot({ path: join(root, 'unified-save-options.png'), fullPage: true });
  await reopened.locator('#confirm-save').click();
  await reopened.locator('#save-dialog').waitFor({ state: 'hidden' });
  assert.equal(saves.length, 0, '关闭同步时仅保存在本地');
  const records = () => reopened.evaluate(async () => {
    const db = await new Promise(resolve => { const request = indexedDB.open('deep-research-reader'); request.onsuccess = () => resolve(request.result); });
    try { return await new Promise(resolve => { const request = db.transaction('insights').objectStore('insights').getAll(); request.onsuccess = () => resolve(request.result); }); }
    finally { db.close(); }
  });
  const firstRecord = (await records())[0];
  assert.equal(firstRecord.aiAnswer, '');
  assert.equal(firstRecord.highlight, true);
  await reopened.locator('#save-selection').click();
  await reopened.locator('#save-dialog').waitFor({ state: 'visible' });
  assert.equal(await reopened.locator('#save-note').inputValue(), 'Only my note');
  await reopened.locator('#save-include-ai').check();
  await reopened.locator('#confirm-save').click();
  await reopened.locator('#save-dialog').waitFor({ state: 'hidden' });
  await reopened.waitForFunction(() => document.querySelector('#notice')?.textContent?.includes('已同步'));
  assert.equal(saves.length, 1);
  assert.equal(saves[0].idempotencyKey, firstRecord.id);
  assert.equal(saves[0].aiAnswer, '有界队列与取消机制共同限制过期工作。');
  assert.equal((await records()).length, 1, '高亮、笔记、AI 解读和同步共用同一记录');

  // A live toolbar click must also submit automatically; on failure its
  // generated question remains visible with a useful recovery message.
  rejectNext = true;
  await article.bringToFront();
  await article.evaluate(() => {
    const range = document.createRange(); range.selectNodeContents(document.querySelector('#first'));
    const selection = window.getSelection(); selection.removeAllRanges(); selection.addRange(range);
    document.querySelector('#first').dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
  });
  await article.locator('[data-deep-research-toolbar] button[data-action="explain"]').click();
  await reopened.waitForFunction(() => document.querySelector('#notice')?.textContent?.includes('重新选择原文'));
  assert.equal(calls.length, 2);
  assert.ok((await reopened.locator('#notice').innerText()).includes('selection-validation-test'));
  assert.equal(await reopened.locator('#conversation-list .conversation-message.user').count(), 2);
  const screenshot = join(root, 'selection-explain.png');
  await reopened.screenshot({ path: screenshot, fullPage: true });
  console.log(JSON.stringify({ ok: true, requests: calls.length, coldPanelAutoExplain: true, crossParagraphAnchor: true, failedQuestionVisible: true, unifiedSaveOptions: true, platformSaves: saves.length, screenshot }));
} catch (error) {
  const state = testedPanel ? await testedPanel.evaluate(async () => {
    const stored = await chrome.storage.session.get(null);
    return {
      notice: document.querySelector('#notice')?.textContent,
      tasks: Object.entries(stored).filter(([key]) => key.startsWith('readerAnswer:')).map(([, task]) => ({ status: task.status, error: task.error })),
    };
  }).catch(() => null) : null;
  console.error(JSON.stringify({ requests: calls.length, platformSaves: saves.length, state }));
  throw error;
} finally {
  await browser.close();
  await new Promise(resolve => server.close(resolve));
}
