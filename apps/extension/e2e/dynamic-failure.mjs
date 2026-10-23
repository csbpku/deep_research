import { createServer } from 'node:http';
import { existsSync } from 'node:fs';
import { cp, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { chromium } from '../../web/node_modules/@playwright/test/index.mjs';
import { join } from 'node:path';
import { tempDir, tempPath } from './temp-paths.mjs';

const extensionPath = await mkdtemp(join(tempDir(), 'reader-dynamic-extension-'));
await cp(new URL('../.output/chrome-mv3', import.meta.url).pathname, extensionPath, { recursive: true });
const manifestPath = `${extensionPath}/manifest.json`;
const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
manifest.host_permissions = [...new Set([...(manifest.host_permissions || []), 'http://127.0.0.1/*'])];
await writeFile(manifestPath, JSON.stringify(manifest));
const pagePort = 8782;
const providerPort = 8806;
let failuresRemaining = 2;
let providerRequests = 0;
let appendDynamicBlock;
let dynamicTriggered = false;

const pageHtml = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Dynamic failure recovery</title><style>body{max-width:860px;margin:32px auto;font:17px/1.6 system-ui,sans-serif}</style></head><body><main><article><h1>Dynamic failure recovery</h1><p id="fail-block">FAIL_DYNAMIC_ONCE This paragraph must remain visible as a retryable failure when the page changes.</p><p id="stable-block">The stable paragraph should translate and remain available while the failing item is retried.</p><pre><code>const next = await queue.take();</code></pre></article></main><iframe title="cross-origin fixture" src="http://127.0.0.1:8783/embedded"></iframe></body></html>`;

const pageServer = createServer((_request, response) => {
  response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
  response.end(pageHtml);
});
await new Promise((resolve, reject) => {
  pageServer.once('error', reject);
  pageServer.listen(pagePort, '127.0.0.1', resolve);
});

function json(response, status, body) {
  response.writeHead(status, {
    'content-type': 'application/json',
    'access-control-allow-origin': '*',
    'cache-control': 'no-cache',
  });
  response.end(JSON.stringify(body));
}

const providerServer = createServer(async (request, response) => {
  if (request.method === 'OPTIONS') {
    response.writeHead(204, {
      'access-control-allow-origin': '*',
      'access-control-allow-headers': 'content-type, authorization',
      'access-control-allow-methods': 'POST, OPTIONS',
    });
    response.end();
    return;
  }
  let raw = '';
  for await (const chunk of request) raw += chunk;
  const payload = raw ? JSON.parse(raw) : {};
  providerRequests += 1;
  const system = String(payload.messages?.find((item) => item.role === 'system')?.content || '');
  const user = payload.messages?.at(-1);
  const content = Array.isArray(user?.content)
    ? user.content.map((part) => part.text || '').join('\n')
    : String(user?.content || '');

  if (system.includes('视觉能力检查器')) {
    json(response, 200, { choices: [{ message: { content: 'READER_VISION_CHECK' } }] });
    return;
  }
  if (system.includes('技术文档翻译编辑') && content.includes('FAIL_DYNAMIC_ONCE') && failuresRemaining > 0) {
    failuresRemaining -= 1;
    json(response, 503, { error: { message: 'temporary dynamic test rate limit' } });
    if (!dynamicTriggered) {
      dynamicTriggered = true;
      await appendDynamicBlock();
    }
    return;
  }

  const answer = system.includes('技术文档翻译编辑')
    ? `译文：${content.replace(/^页面标题：[\s\S]*?原文：\n/u, '').slice(0, 120)}`
    : 'OK';
  await new Promise((resolve) => setTimeout(resolve, 120));
  if (payload.stream) {
    response.writeHead(200, {
      'content-type': 'text/event-stream',
      'access-control-allow-origin': '*',
      'cache-control': 'no-cache',
    });
    response.end(`data: ${JSON.stringify({ choices: [{ delta: { content: answer } }] })}\n\ndata: [DONE]\n\n`);
    return;
  }
  json(response, 200, { choices: [{ message: { content: answer } }] });
});
await new Promise((resolve, reject) => {
  providerServer.once('error', reject);
  providerServer.listen(providerPort, '127.0.0.1', resolve);
});

const executablePath = process.env.CHROME_FOR_TESTING
  || [
    '/Users/shaobo.chen/Library/Caches/ms-playwright/chromium-1234/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  ].find(existsSync);
if (!executablePath) throw new Error('找不到 Chrome，请设置 CHROME_FOR_TESTING');

const context = await chromium.launchPersistentContext(tempPath(`deep-research-reader-dynamic-failure-${Date.now()}`), {
  executablePath,
  headless: process.env.READER_HEADLESS === '1',
  viewport: { width: 1280, height: 900 },
  args: ['--enable-extensions', `--disable-extensions-except=${extensionPath}`, `--load-extension=${extensionPath}`, '--no-first-run', '--no-default-browser-check'],
});

try {
  const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
  const extensionId = new URL(worker.url()).host;
  const page = await context.newPage();
  await page.goto(`http://127.0.0.1:${pagePort}/`, { waitUntil: 'domcontentloaded' });
  appendDynamicBlock = () => page.evaluate(() => {
    const p = document.createElement('p');
    p.id = 'dynamic-block';
    p.textContent = 'Dynamic content arrived after the first translation snapshot and must enter the queue.';
    document.querySelector('article').append(p);
  });
  const panel = await context.newPage();
  await panel.goto(`chrome-extension://${extensionId}/sidepanel.html`, { waitUntil: 'domcontentloaded' });
  await page.bringToFront();
  const tabId = await worker.evaluate(async () => {
    const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    if (!tab?.id) throw new Error('动态失败页面未激活');
    await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['content.js'] });
    await chrome.tabs.sendMessage(tab.id, { type: 'deep-research:request-page' });
    return tab.id;
  });
  await panel.locator('#page-view').waitFor({ state: 'visible', timeout: 10_000 });
  await panel.locator('#scope-notice').waitFor({ state: 'visible', timeout: 10_000 });
  if (!(await panel.locator('#scope-notice').innerText()).includes('跨域 iframe')) throw new Error('跨域 iframe 范围限制没有显示');
  await panel.locator('#settings-button').click();
  await panel.locator('#provider-kind').selectOption('custom', { force: true });
  await panel.locator('#provider-url').fill(`http://127.0.0.1:${providerPort}/v1`);
  await panel.locator('#manual-model-settings .MuiAccordionSummary-root').click();
  await panel.locator('#provider-model').fill('dynamic-reader');
  await panel.locator('#provider-key').fill('dynamic-test-key');
  await panel.locator('#save-settings').click();
  await panel.locator('#settings-notice').waitFor({ state: 'visible', timeout: 10_000 });
  await panel.locator('#close-settings').click();
  await panel.locator('#chat-translate').click();

  // Wait for the dynamically appended block to be translated. Its arrival
  // forces a new page snapshot while the old job may still contain a failure.
  await page.waitForSelector('#dynamic-block', { state: 'attached', timeout: 10_000 });
  await page.waitForFunction(() => Boolean(document.querySelector('#dynamic-block')?.nextElementSibling?.hasAttribute('data-deep-research-translation')), null, { timeout: 30_000 });
  await panel.waitForFunction(() => document.querySelector('#progress-area')?.getAttribute('aria-busy') === 'false'
    && ['completed', 'error'].includes(document.querySelector('#translation-summary')?.dataset.state), null, { timeout: 30_000 });
  if (failuresRemaining !== 0) {
    throw new Error(`预设的两次临时失败未触发：${JSON.stringify({ providerRequests, failuresRemaining })}`);
  }
  let recovery = 'automatic';
  const failurePanel = panel.locator('#translation-failures');
  if (await failurePanel.isVisible()) {
    const failureText = await failurePanel.innerText();
    if (!failureText.includes('FAIL_DYNAMIC_ONCE')) throw new Error(`动态更新后失败列表丢失原失败项：${failureText}`);
    recovery = 'manual-retry';
    await panel.locator('.translation-retry').first().click();
    // Assert on the rendered rows: the phrase this used to check for is not
    // part of the extension's copy, so the old condition never failed.
    await panel.waitForFunction(() => !document.querySelector('#translation-failures .translation-failure-row'), null, { timeout: 30_000 });
  } else {
    await page.waitForFunction(() => Boolean(document.querySelector('#fail-block')?.nextElementSibling?.hasAttribute('data-deep-research-translation')), null, { timeout: 30_000 });
  }
  const final = await page.evaluate(() => ({
    dynamicTranslated: Boolean(document.querySelector('#dynamic-block')?.nextElementSibling?.hasAttribute('data-deep-research-translation')),
    failedBlockTranslated: Boolean(document.querySelector('#fail-block')?.nextElementSibling?.hasAttribute('data-deep-research-translation')),
    failureRows: document.querySelectorAll('[data-deep-research-translation]').length,
  }));
  if (!final.dynamicTranslated || !final.failedBlockTranslated || await failurePanel.isVisible()) {
    throw new Error(`动态正文或失败段恢复不完整：${JSON.stringify({ recovery, final, failures: await failurePanel.innerText().catch(() => '') })}`);
  }
  // Simulate an older installed extractor having queued a decorative footer
  // image. A viewport or truncated snapshot must preserve that failure; only
  // a new complete article inventory may retire it. Use the real content
  // script's inventory and IndexedDB job so the worker/UI handoff is covered.
  await panel.close();
  const fullContext = await worker.evaluate(async (tabId) => new Promise((resolve, reject) => {
    const timer = setTimeout(() => { chrome.runtime.onMessage.removeListener(receive); reject(new Error('Full inventory timed out')); }, 10000);
    function receive(message, sender) {
      const payload = message.type === 'deep-research:from-page' ? message.payload : message;
      if (payload?.type !== 'deep-research:full-document' || sender.tab?.id !== tabId) return;
      clearTimeout(timer); chrome.runtime.onMessage.removeListener(receive);
      resolve(payload.context);
    }
    chrome.runtime.onMessage.addListener(receive);
    chrome.tabs.sendMessage(tabId, { type: 'deep-research:request-full-document' }).catch(reject);
  }), tabId);
  if (!fullContext.full || fullContext.imageCandidateCount !== 0 || fullContext.imageTruncated !== false) throw new Error('Fixture did not provide a complete empty image inventory');
  const inspection = await context.newPage();
  // A non-panel extension page keeps the test from implicitly starting jobs.
  await inspection.goto(`chrome-extension://${extensionId}/privacy.html`);
  async function storedJob(nextJob = null) {
    return inspection.evaluate(async ({ id, nextJob }) => new Promise((resolve, reject) => {
      const request = indexedDB.open('deep-research-reader');
      request.onerror = () => reject(request.error);
      request.onsuccess = () => {
        const database = request.result;
        const transaction = database.transaction('jobs', nextJob ? 'readwrite' : 'readonly');
        const operation = nextJob ? transaction.objectStore('jobs').put(nextJob) : transaction.objectStore('jobs').get(id);
        transaction.oncomplete = () => { database.close(); resolve(nextJob || operation.result); };
        transaction.onerror = () => { database.close(); reject(transaction.error); };
      };
    }), { id: 'old-footer-scope-job', nextJob });
  }
  const oldFailure = { id: 'legacy-footer-decoration', kind: 'image', label: 'Removed footer ornament', error: 'Old image recognition failed' };
  const requestsBeforeScopeRecovery = providerRequests;
  for (const snapshot of [
    { ...fullContext, full: false, blocks: [], images: [] },
    { ...fullContext, imageTruncated: true, blocks: [], images: [] },
    { ...fullContext, imageCandidateCount: 41, blocks: [], images: [] },
  ]) {
    await storedJob({ id: 'old-footer-scope-job', documentUrl: fullContext.url, contentHash: fullContext.contentHash, kind: 'text', status: 'queued', failedItems: [oldFailure], updatedAt: new Date().toISOString() });
    await inspection.evaluate(async ({ tabId, context }) => {
      const accepted = await chrome.runtime.sendMessage({ type: 'deep-research:translation-start', jobId: 'old-footer-scope-job', tabId, context });
      if (!accepted?.ok) throw new Error('Worker refused scope recovery test');
    }, { tabId, context: { ...snapshot, targetLanguage: 'zh-CN' } });
    await inspection.waitForFunction(async () => new Promise((resolve) => {
      const open = indexedDB.open('deep-research-reader');
      open.onsuccess = () => {
        const db = open.result;
        const tx = db.transaction('jobs', 'readonly');
        const get = tx.objectStore('jobs').get('old-footer-scope-job');
        tx.oncomplete = () => { db.close(); resolve(get.result?.status === 'completed_with_errors'); };
      };
    }), null, { timeout: 10_000 });
    const preserved = await storedJob();
    if (preserved.failedItems?.[0]?.id !== oldFailure.id) throw new Error('Incomplete inventory incorrectly discarded a failure');
  }
  const resumed = await context.newPage();
  await resumed.goto(`chrome-extension://${extensionId}/sidepanel.html`);
  await page.bringToFront();
  await worker.evaluate(async (tabId) => chrome.tabs.sendMessage(tabId, { type: 'deep-research:request-page' }), tabId);
  await resumed.waitForFunction(() => document.querySelector('#translation-failures')?.textContent?.includes('Removed footer ornament'), null, { timeout: 10_000 });
  await resumed.locator('#chat-translate').click();
  await resumed.waitForFunction(() => document.querySelector('#notice')?.textContent?.includes('全文翻译完成。'), null, { timeout: 15_000 });
  const reconciled = await storedJob();
  if (reconciled.status !== 'completed' || reconciled.failedItems?.length || await resumed.locator('#translation-failures').isVisible()) throw new Error(`Removed image failure survived the full inventory: ${JSON.stringify(reconciled)}`);
  await resumed.close();
  await storedJob({ ...reconciled, status: 'completed_with_errors', failedItems: [oldFailure], workerManaged: false });
  const fallback = await context.newPage();
  await fallback.goto(`chrome-extension://${extensionId}/sidepanel.html`);
  // Explicitly reject only the worker handoff to exercise the shipped
  // panel-local fallback, leaving page messages and provider calls intact.
  await fallback.evaluate(() => {
    const send = chrome.runtime.sendMessage.bind(chrome.runtime);
    window.scopeRecoveryFallbackAttempts = 0;
    chrome.runtime.sendMessage = (message, ...args) => {
      if (message?.type === 'deep-research:translation-start') {
        window.scopeRecoveryFallbackAttempts += 1;
        return Promise.resolve({ ok: false });
      }
      return send(message, ...args);
    };
  });
  await page.bringToFront();
  await worker.evaluate(async (tabId) => chrome.tabs.sendMessage(tabId, { type: 'deep-research:request-page' }), tabId);
  await fallback.waitForFunction(() => document.querySelector('#translation-failures')?.textContent?.includes('Removed footer ornament'), null, { timeout: 10_000 });
  await fallback.locator('#chat-translate').click();
  await fallback.waitForFunction(() => document.querySelector('#notice')?.textContent?.includes('全文翻译完成。'), null, { timeout: 15_000 });
  const fallbackJob = await storedJob();
  if (fallbackJob.status !== 'completed' || fallbackJob.failedItems?.length || await fallback.locator('#translation-failures').isVisible()) throw new Error(`Fallback retained the removed image failure: ${JSON.stringify(fallbackJob)}`);
  if (await fallback.evaluate(() => window.scopeRecoveryFallbackAttempts) !== 1) throw new Error('Panel-local fallback was not exercised');
  if (providerRequests !== requestsBeforeScopeRecovery) throw new Error('Scope recovery unexpectedly called the model instead of reusing translations');
  console.log(JSON.stringify({ extensionId, tabId, failuresRemaining, recovery, final, scopeRecovery: { partialAndTruncatedPreserved: true, fullInventoryCleared: true, panelFallbackCleared: true, extraModelRequests: providerRequests - requestsBeforeScopeRecovery } }, null, 2));
} finally {
  await context.close().catch(() => {});
  await new Promise((resolve) => providerServer.close(resolve));
  await new Promise((resolve) => pageServer.close(resolve));
}
