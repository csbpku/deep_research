import { createHash, randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { cp, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { chromium } from '../../../apps/web/node_modules/@playwright/test/index.mjs';

// Platform mode is optional: the same package remains usable as an independent
// reader, while this harness verifies the account-connected integration path.
if (process.env.READER_PLATFORM_E2E !== '1') {
  console.log(JSON.stringify({ skipped: true, reason: '设置 READER_PLATFORM_E2E=1 运行可选平台模式的 PKCE、SSE、会话与知识保存验收。' }));
  process.exit(0);
}

const fixturePath = new URL('./fixture.html', import.meta.url);
const port = 8890;
const token = `reader-test-token-${randomUUID()}`;
const liveEngineUrl = String(process.env.READER_PLATFORM_LIVE_ENGINE_URL || '').trim().replace(/\/+$/u, '');
const authorizationCodes = new Map();
let liveEngineRequestStarted = false;
const received = {
  requests: [], exchanges: [], answers: [], sessions: [], saves: [], revokes: [],
  liveEngine: null, liveEngineError: null,
};

function json(response, status, body) {
  response.writeHead(status, { 'content-type': 'application/json', 'access-control-allow-origin': '*' });
  response.end(JSON.stringify(body));
}

const server = createServer(async (request, response) => {
  const url = new URL(request.url || '/', `http://127.0.0.1:${port}`);
  received.requests.push({ method: request.method, path: url.pathname });
  if (request.method === 'OPTIONS') {
    response.writeHead(204, { 'access-control-allow-origin': '*', 'access-control-allow-headers': 'authorization,content-type', 'access-control-allow-methods': 'GET,POST,OPTIONS' });
    response.end();
    return;
  }
  if (url.pathname === '/healthz') {
    response.writeHead(200, { 'access-control-allow-origin': '*' });
    response.end('ok');
    return;
  }
  if (url.pathname === '/fixture.html') {
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    response.end(await readFile(fixturePath));
    return;
  }
  if (url.pathname === '/reading/connect') {
    const redirect = url.searchParams.get('redirect') || '';
    const challenge = url.searchParams.get('code_challenge') || '';
    const state = url.searchParams.get('state') || '';
    const code = `code-${randomUUID()}`;
    authorizationCodes.set(code, { redirect, challenge, state, used: false });
    const callback = new URL(redirect);
    callback.searchParams.set('code', code);
    callback.searchParams.set('state', state);
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    response.end(`<!doctype html><title>Mock login</title><script>window.location.replace(${JSON.stringify(callback.toString())})</script>`);
    return;
  }
  if (url.pathname === '/api/reading/token/exchange' && request.method === 'POST') {
    let raw = '';
    for await (const chunk of request) raw += chunk;
    const input = JSON.parse(raw || '{}');
    const record = authorizationCodes.get(input.code);
    const digest = createHash('sha256').update(String(input.code_verifier || '')).digest('base64url');
    received.exchanges.push({ code: input.code, redirect: input.redirect, validPkce: Boolean(record && !record.used && record.redirect === input.redirect && record.challenge === digest) });
    if (!record || record.used || record.redirect !== input.redirect || record.challenge !== digest) {
      json(response, 400, { ok: false, message: 'invalid PKCE code' });
      return;
    }
    record.used = true;
    json(response, 200, { ok: true, token, expiresInSeconds: 120 });
    return;
  }
  const auth = request.headers.authorization || '';
  if (url.pathname === '/api/reading/answer/stream' && request.method === 'POST') {
    let raw = '';
    for await (const chunk of request) raw += chunk;
    const input = JSON.parse(raw || '{}');
    received.answers.push({ token: auth, input });
    if (auth !== `Bearer ${token}`) {
      json(response, 401, { ok: false, message: 'unauthorized' });
      return;
    }
    if (input.prompt === 'simulate-provider-402') {
      response.writeHead(200, {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-cache',
        'access-control-allow-origin': '*',
      });
      response.end('event: error\ndata: {"message":"APIStatusError: Error code: 402 - insufficient_balance_error","request_id":"mock-402-id"}\n\n');
      return;
    }
    if (liveEngineUrl && !liveEngineRequestStarted && input.context?.scope === 'page') {
      liveEngineRequestStarted = true;
      try {
        const context = input.context || {};
        const engineBody = context.scope === 'page'
          ? String(context.body || '')
          : String(context.section || context.selection?.quote || context.body || '');
        const upstream = await fetch(`${liveEngineUrl}/api/ai/research-assistant/stream`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', accept: 'text/event-stream' },
          body: JSON.stringify({
            operation: ['explain', 'translate'].includes(input.action) ? input.action : 'ask',
            body: engineBody,
            scope: context.scope,
            instruction: input.prompt || undefined,
            topic: context.title || '技术文章',
            requester_id: '00000000-0000-4000-8000-000000000001',
          }),
        });
        const frames = (await upstream.text()).split(/\r?\n\r?\n/u).filter(Boolean);
        if (!upstream.ok) {
          response.writeHead(502, { 'content-type': 'application/json', 'access-control-allow-origin': '*' });
          response.end(JSON.stringify({ message: '本机 AI Engine 请求失败', status: upstream.status }));
          return;
        }
        const mappedFrames = frames.map((frame) => {
          if (/^event:\s*error(?:\r?\n|$)/mu.test(frame)) {
            const data = frame.split(/\r?\n/u).filter((line) => line.startsWith('data:'))
              .map((line) => line.slice(5).trim()).join('\n');
            const error = JSON.parse(data);
            received.liveEngineError = {
              code: typeof error.code === 'string' ? error.code : null,
              message: typeof error.message === 'string' ? error.message.slice(0, 500) : null,
              requestId: typeof error.request_id === 'string' ? error.request_id : null,
            };
            return frame;
          }
          if (!/^event:\s*done(?:\r?\n|$)/mu.test(frame)) return frame;
          const data = frame.split(/\r?\n/u).filter((line) => line.startsWith('data:'))
            .map((line) => line.slice(5).trim()).join('\n');
          const result = JSON.parse(data);
          const reading = result.reading && typeof result.reading === 'object' ? result.reading : null;
          const sourceBody = String(context.body || '');
          const sourceHash = createHash('sha256').update(sourceBody, 'utf8').digest('hex');
          const citations = Array.isArray(reading?.evidence)
            ? reading.evidence.flatMap((item) => {
                const quote = typeof item.quote === 'string' ? item.quote.trim() : '';
                const start = quote ? sourceBody.indexOf(quote) : -1;
                if (!quote || start < 0) return [];
                const end = start + quote.length;
                return [{
                  quote,
                  url: context.url,
                  anchor: {
                    quote,
                    prefix: sourceBody.slice(Math.max(0, start - 120), start),
                    suffix: sourceBody.slice(end, end + 120),
                    startOffset: start,
                    endOffset: end,
                    contentHash: sourceHash,
                  },
                }];
              })
            : [];
          result.source = { url: context.url, title: context.title, scope: context.scope, anchor: context.selection || null };
          result.citations = citations;
          if (reading) reading.evidence = reading.evidence.map((item) => {
            const citation = citations.find((entry) => entry.quote === item.quote);
            return citation ? { ...item, anchor: citation.anchor, url: citation.url } : item;
          });
          received.liveEngine = {
            provider: result.metrics?.provider || null,
            model: result.metrics?.model || null,
            inputTokens: result.metrics?.token_input_total || 0,
            outputTokens: result.metrics?.token_output_total || 0,
            latencyMs: result.metrics?.latency_ms || 0,
            evidenceCount: citations.length,
          };
          return `event: done\ndata: ${JSON.stringify(result)}`;
        });
        response.writeHead(200, {
          'content-type': 'text/event-stream; charset=utf-8',
          'cache-control': 'no-cache',
          'access-control-allow-origin': '*',
        });
        response.end(`${mappedFrames.join('\n\n')}\n\n`);
      } catch (error) {
        response.writeHead(502, { 'content-type': 'application/json', 'access-control-allow-origin': '*' });
        response.end(JSON.stringify({ message: error instanceof Error ? error.message : '本机 AI Engine 请求失败' }));
      }
      return;
    }
    response.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache',
      'access-control-allow-origin': '*',
    });
    response.write('event: delta\ndata: {"text":"平台证据回答："}\n\n');
    response.write('event: delta\ndata: {"text":"边界明确。"}\n\n');
    response.end(`event: done\ndata: ${JSON.stringify({
      reading: {
        answer: '平台证据回答：边界明确。',
        background: '来自当前技术文章选段。',
        evidence: [{ quote: input.context?.selection?.quote || '', reason: '直接支持结论' }],
        inference: '回答由平台 SSE 返回。',
        limitations: ['只覆盖当前选段。'],
        warnings: [],
      },
    })}\n\n`);
    return;
  }
  if (url.pathname === '/api/reading/session' && request.method === 'POST') {
    let raw = '';
    for await (const chunk of request) raw += chunk;
    const input = JSON.parse(raw || '{}');
    received.sessions.push({ token: auth, input });
    json(response, auth === `Bearer ${token}` ? 200 : 401, { ok: auth === `Bearer ${token}`, session: input });
    return;
  }
  if (url.pathname === '/api/reading/save' && request.method === 'POST') {
    let raw = '';
    for await (const chunk of request) raw += chunk;
    const input = JSON.parse(raw || '{}');
    received.saves.push({ token: auth, input });
    const valid = auth === `Bearer ${token}`;
    const status = !valid ? 401 : received.saves.length === 1 ? 503 : 201;
    json(response, status, valid && received.saves.length === 1
      ? { message: '模拟一次性网络故障' }
      : { ok: valid, deduplicated: false, draft: { id: 'draft-test', status: 'draft' } });
    return;
  }
  if (url.pathname === '/api/reading/token/revoke' && request.method === 'POST') {
    received.revokes.push({ token: auth });
    json(response, auth === `Bearer ${token}` ? 200 : 401, { ok: auth === `Bearer ${token}`, revoked: auth === `Bearer ${token}` });
    return;
  }
  response.writeHead(404);
  response.end('not found');
});
await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve); });

const extensionPath = process.env.READER_E2E_EXTENSION_PATH || new URL('../.output/chrome-mv3', import.meta.url).pathname;
const testExtensionRoot = await mkdtemp('/private/tmp/deep-research-reader-pkce-extension-');
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

const context = await chromium.launchPersistentContext(`/private/tmp/deep-research-reader-pkce-${Date.now()}`, {
  executablePath,
  headless: process.env.READER_HEADLESS === '1',
  viewport: { width: 1280, height: 900 },
  args: ['--enable-extensions', `--disable-extensions-except=${testExtensionPath}`, `--load-extension=${testExtensionPath}`, '--no-first-run', '--no-default-browser-check'],
});

try {
  const serviceWorker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
  const extensionId = new URL(serviceWorker.url()).host;
  const unsolicitedCallback = await context.newPage();
  await unsolicitedCallback.goto(`http://127.0.0.1:${port}/fixture.html`, { waitUntil: 'domcontentloaded' });
  await unsolicitedCallback.evaluate((url) => window.location.assign(url), `chrome-extension://${extensionId}/callback.html?token=unsolicited`);
  await unsolicitedCallback.waitForURL(`chrome-extension://${extensionId}/callback.html?token=unsolicited`);
  if ((await serviceWorker.evaluate(async () => chrome.storage.local.get('readerToken'))).readerToken) {
    throw new Error('unsolicited callback stored a reader token');
  }
  await unsolicitedCallback.close();
  const page = await context.newPage();
  await page.goto(`http://127.0.0.1:${port}/fixture.html`, { waitUntil: 'domcontentloaded' });
  await page.evaluate(() => {
    for (const attribute of ['data-deep-research-toolbar', 'data-deep-research-dock', 'data-deep-research-status']) {
      const staleHost = document.createElement('div');
      staleHost.setAttribute(attribute, 'true');
      staleHost.dataset.staleReaderUi = 'true';
      document.documentElement.appendChild(staleHost);
    }
  });
  await page.bringToFront();
  const panel = await context.newPage();
  await panel.goto(`chrome-extension://${extensionId}/sidepanel.html`, { waitUntil: 'domcontentloaded' });
  await page.bringToFront();
  const localPlatformUrl = `http://127.0.0.1:${port}`;
  await panel.evaluate(async (url) => {
    const database = await new Promise((resolve, reject) => {
      const request = indexedDB.open('deep-research-reader', 4);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    await new Promise((resolve, reject) => {
      const transaction = database.transaction('settings', 'readwrite');
      transaction.objectStore('settings').put({ id: 'platformUrl', value: url, updatedAt: new Date().toISOString() });
      transaction.oncomplete = resolve;
      transaction.onerror = () => reject(transaction.error);
    });
    database.close();
  }, localPlatformUrl);
  await serviceWorker.evaluate(async (url) => chrome.storage.local.set({ readerPlatformUrl: url }), localPlatformUrl);
  await panel.reload({ waitUntil: 'domcontentloaded' });
  await panel.waitForFunction(() => document.documentElement.dataset.readerReady === 'true', null, { timeout: 15_000 });

  await panel.bringToFront();
  await panel.locator('#settings-button').click();
  await panel.locator('#mode-platform').click();
  await panel.waitForFunction(() => document.querySelector('#storage-status')?.textContent === '平台模式', null, { timeout: 5_000 });
  if (await panel.locator('#platform-url').count()) throw new Error('平台设置仍要求手动填写地址');
  if ((await panel.locator('#platform-target').innerText()) !== `127.0.0.1:${port}`) throw new Error('平台目标没有读取已配置的平台来源');
  const authorizationPage = context.waitForEvent('page');
  await panel.locator('#connect-platform').click();
  await authorizationPage;
  // The test-only manifest pre-authorizes localhost so headless Chrome can
  // inject into the fixture without changing the shipped extension's grants.
  await serviceWorker.evaluate(async (origin) => {
    const [tab] = await chrome.tabs.query({ url: `${origin}/fixture.html` });
    if (!tab?.id) throw new Error('fixture tab is missing');
    const granted = await chrome.permissions.contains({ origins: [`${origin}/*`] });
    if (!granted) throw new Error('mock platform host permission was not granted');
    await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['content.js'] });
    await chrome.tabs.sendMessage(tab.id, { type: 'deep-research:request-page' });
  }, localPlatformUrl);
  const transientUi = await page.evaluate(() => ({
    staleCount: document.querySelectorAll('[data-stale-reader-ui="true"]').length,
    dockCount: document.querySelectorAll('[data-deep-research-dock]').length,
    statusCount: document.querySelectorAll('[data-deep-research-status]').length,
  }));
  if (transientUi.staleCount || transientUi.dockCount !== 1 || transientUi.statusCount > 1) {
    throw new Error(`extension reinjection left stale or duplicate transient controls: ${JSON.stringify(transientUi)}`);
  }
  for (let attempt = 0; attempt < 30 && authorizationCodes.size === 0; attempt += 1) await new Promise((resolve) => setTimeout(resolve, 100));
  if (authorizationCodes.size === 0) throw new Error(`mock authorization page was not opened: ${JSON.stringify(received.requests)}`);
  await panel.locator('#platform-status').waitFor({ state: 'visible', timeout: 15_000 });
  try {
    await panel.waitForFunction(() => document.querySelector('#platform-status')?.textContent?.includes('已连接'), null, { timeout: 15_000 });
  } catch (error) {
    throw new Error(`platform connect failed: ${JSON.stringify({ status: await panel.locator('#platform-status').innerText().catch(() => ''), body: (await panel.locator('body').innerText().catch(() => '')).slice(-1000), requests: received.requests, exchanges: received.exchanges, pages: context.pages().map((item) => item.url()) })}; ${error.message}`);
  }

  // The public-page dock must keep using the connected platform's AI Engine.
  // Run this action first so a live acceptance makes exactly one model call.
  await panel.locator('#close-settings').click();
  const pageContextReady = await panel.waitForFunction(
    () => Boolean(document.querySelector('#page-source')?.textContent),
    null,
    { timeout: 5_000 },
  ).then(() => true).catch(() => false);
  try {
    if (!pageContextReady) {
      await serviceWorker.evaluate(async (origin) => {
        const [tab] = await chrome.tabs.query({ url: `${origin}/fixture.html` });
        if (tab?.id) await chrome.tabs.sendMessage(tab.id, { type: 'deep-research:request-page' });
      }, localPlatformUrl);
    }
    await panel.waitForFunction(() => Boolean(document.querySelector('#page-source')?.textContent), null, { timeout: 10_000 });
  } catch (error) {
    throw new Error(`page context was not delivered after re-injection: ${JSON.stringify({
      pageViewVisible: await panel.locator('#page-view').isVisible().catch(() => false),
      pageSource: await panel.locator('#page-source').innerText().catch(() => ''),
      pageTitle: await panel.locator('#page-title').innerText().catch(() => ''),
      status: await panel.locator('#page-context-status').innerText().catch(() => ''),
      activation: await panel.locator('#empty-view').innerText().catch(() => ''),
      pageUrl: page.url(),
      browserTabs: await serviceWorker.evaluate(async () => (await chrome.tabs.query({})).map((tab) => ({ id: tab.id, url: tab.url, active: tab.active })), null).catch(() => []),
      readerContexts: await serviceWorker.evaluate(async () => Object.entries(await chrome.storage.session.get(null))
        .filter(([key]) => key.startsWith('readerContext:'))
        .map(([key, value]) => ({ key, type: value?.type || null, url: value?.context?.url || null, bodyChars: value?.context?.body?.length || 0 })), null).catch(() => []),
      pageDockCount: await page.locator('[data-deep-research-dock]').count().catch(() => -1),
    })}; ${error.message}`);
  }
  await page.bringToFront();
  const dockBounds = await page.locator('[data-deep-research-dock]').boundingBox();
  if (!dockBounds) throw new Error('right dock has no clickable bounds after platform connection');
  await page.mouse.click(dockBounds.x + dockBounds.width - 27, dockBounds.y + 22);
  let liveAnswerText = '';
  if (liveEngineUrl) {
    try {
      await panel.waitForFunction(() => {
        const answers = [...document.querySelectorAll('.conversation-message.assistant .conversation-message-body')];
        const answer = answers.at(-1)?.textContent?.trim() || '';
        const evidence = document.querySelector('#answer-evidence-list')?.textContent?.trim() || '';
        return answer.length > 40 && evidence.length > 0;
      }, null, { timeout: 90_000 });
      liveAnswerText = await panel.locator('.conversation-message.assistant .conversation-message-body').last().innerText();
      if (!['核心结论', '关键机制', '风险与取舍', '待核对'].every((heading) => liveAnswerText.includes(heading))) {
        throw new Error(`live page summary did not contain all requested Markdown sections: ${liveAnswerText.slice(0, 700)}`);
      }
    } catch (error) {
      throw new Error(`live AI Engine page summary did not render with evidence: ${JSON.stringify({
        answer: await panel.locator('.conversation-message.assistant .conversation-message-body').last().innerText().catch(() => ''),
        structured: await panel.locator('#answer-structured').innerText().catch(() => ''),
        notice: await panel.locator('#notice').innerText().catch(() => ''),
        metrics: received.liveEngine,
        providerError: received.liveEngineError,
      })}; ${error.message}`);
    }
  } else {
    await panel.waitForFunction(
      () => document.querySelector('#answer-output')?.textContent?.includes('平台证据回答：边界明确。'),
      null,
      { timeout: 10_000 },
    );
  }
  const summaryRequest = received.answers.find((item) => item.input?.context?.scope === 'page');
  if (!summaryRequest || summaryRequest.input.action !== 'ask' || !summaryRequest.input.prompt?.includes('核心结论')) {
    throw new Error(`dock summary did not reach platform mode as a full-page summary: ${JSON.stringify(summaryRequest)}`);
  }

  // Exercise the explicit knowledge path after the account connection:
  // select source text, review the local save dialog, then send the confirmed
  // insight to the optional research-library endpoint.
  await page.bringToFront();
  await page.evaluate(() => {
    const node = document.querySelector('#target');
    if (!node) throw new Error('fixture target paragraph is missing');
    const range = document.createRange();
    range.selectNodeContents(node);
    const selection = window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);
    node.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
  });
  await panel.locator('#selection-section').waitFor({ state: 'visible', timeout: 10_000 });
  await panel.locator('#explain-selection').click();
  await panel.waitForFunction(
    () => document.querySelector('#answer-output')?.textContent?.includes('平台证据回答：边界明确。'),
    null,
    { timeout: 10_000 },
  );
  await panel.locator('#question-input').fill('simulate-provider-402');
  await panel.locator('#send-question').click();
  await panel.waitForFunction(() => document.querySelector('#notice')?.textContent?.includes('平台模型额度不足'), null, { timeout: 10_000 });
  const providerErrorNotice = await panel.locator('#notice').innerText();
  if (providerErrorNotice.includes('APIStatusError') || providerErrorNotice.includes('insufficient_balance_error')
    || !providerErrorNotice.includes('mock-402-id')) {
    throw new Error(`platform provider errors should be friendly and traceable: ${providerErrorNotice}`);
  }
  // The harness opens the side panel as a normal extension tab because
  // Playwright cannot automate Chrome's native side-panel surface. Refocus
  // the article and refresh its context before the save gesture, matching the
  // real user's article -> side panel interaction.
  await page.bringToFront();
  await serviceWorker.evaluate(async () => {
    const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    if (tab?.id) await chrome.tabs.sendMessage(tab.id, { type: 'deep-research:request-page' });
  });
  await page.evaluate(() => {
    const node = document.querySelector('#target');
    if (!node) throw new Error('fixture target paragraph is missing');
    const range = document.createRange();
    range.selectNodeContents(node);
    const selection = window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);
    node.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
  });
  await panel.waitForFunction(
    () => document.querySelector('#page-source')?.textContent?.includes('/fixture.html'),
    null,
    { timeout: 10_000 },
  );
  await panel.locator('#selection-section').waitFor({ state: 'visible', timeout: 10_000 });
  const saveActionState = await panel.locator('#save-selection').evaluate((node) => {
    const ancestors = [];
    for (let current = node; current; current = current.parentElement) {
      const style = getComputedStyle(current);
      ancestors.push({ id: current.id, className: current.className, display: style.display, visibility: style.visibility });
    }
    return ancestors;
  });
  if (saveActionState.some((item) => item.display === 'none' || item.visibility === 'hidden')) {
    throw new Error(`save-selection hidden after answer: ${JSON.stringify(saveActionState)}`);
  }
  await panel.locator('#save-selection').click();
  await panel.locator('#save-dialog').waitFor({ state: 'visible', timeout: 10_000 });
  await serviceWorker.evaluate(async (origin) => {
    const [tab] = await chrome.tabs.query({ url: `${origin}/fixture.html` });
    if (!tab?.id) throw new Error('fixture tab is missing before save');
    await chrome.tabs.sendMessage(tab.id, { type: 'deep-research:request-page' });
  }, localPlatformUrl);
  await panel.waitForTimeout(300);
  if (await panel.locator('#page-view').isVisible() || await panel.locator('#persistent-composer').isVisible()) {
    throw new Error('page context update covered the save dialog');
  }
  await panel.locator('#confirm-save').click();
  try {
    await panel.locator('#sync-selection').waitFor({ state: 'visible', timeout: 10_000 });
  } catch (error) {
    const diagnostic = await panel.evaluate(async () => ({
      platformStatus: document.querySelector('#platform-status')?.textContent || '',
      mode: document.querySelector('#storage-status')?.textContent || '',
      notice: document.querySelector('#notice')?.textContent || '',
      saveNotice: document.querySelector('#save-notice')?.textContent || '',
      saveHidden: document.querySelector('#save-dialog')?.classList.contains('hidden'),
      syncHidden: document.querySelector('#sync-selection')?.classList.contains('hidden'),
      tokenPresent: Boolean((await chrome.storage.local.get(['readerToken'])).readerToken),
    }));
    throw new Error(`sync action stayed hidden: ${JSON.stringify(diagnostic)}; ${error.message}`);
  }
  if (await panel.locator('#sync-selection').innerText() !== '重试同步') {
    throw new Error('the manual sync action must be labeled as a retry');
  }
  await panel.locator('#sync-selection').click();
  await panel.waitForFunction(() => document.querySelector('#notice')?.textContent?.includes('同步到 Deep Research'), null, { timeout: 10_000 });
  if (received.saves.length !== 2 || received.saves[0].input.idempotencyKey !== received.saves[1].input.idempotencyKey) {
    throw new Error('automatic save and explicit retry must reuse the same idempotency key');
  }
  await panel.locator('#sync-selection').waitFor({ state: 'hidden', timeout: 10_000 });

  // Keep the fixture as the active tab, then use the hidden extension page as
  // a deterministic driver for the session sync request.
  await page.bringToFront();
  await serviceWorker.evaluate(async () => {
    const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    if (tab?.id) await chrome.tabs.sendMessage(tab.id, { type: 'deep-research:request-page' });
  });
  await panel.waitForFunction(() => Boolean(document.querySelector('#sync-session') && !document.querySelector('#sync-session').classList.contains('hidden')), null, { timeout: 10_000 });
  await panel.locator('#sync-session').evaluate((node) => node.click());
  await panel.waitForTimeout(800);
  await panel.locator('#disconnect-platform').evaluate((node) => node.click());
  try {
    await panel.waitForFunction(() => document.querySelector('#disconnect-platform')?.classList.contains('hidden'), null, { timeout: 10_000 });
  } catch (error) {
    throw new Error(`platform disconnect failed: ${JSON.stringify({ status: await panel.locator('#platform-status').innerText().catch(() => ''), revokes: received.revokes, sessions: received.sessions.length, body: (await panel.locator('body').innerText().catch(() => '')).slice(-700) })}; ${error.message}`);
  }

  const stored = await serviceWorker.evaluate(async () => chrome.storage.local.get(['readerToken', 'readerPlatformUrl']));
  const summary = {
    extensionId,
    pkceExchange: received.exchanges[0] || null,
    dockSummary: summaryRequest ? {
      authorized: summaryRequest.token === `Bearer ${token}`,
      action: summaryRequest.input?.action,
      scope: summaryRequest.input?.context?.scope,
      prompt: String(summaryRequest.input?.prompt || '').slice(0, 220),
    } : null,
    platformAnswer: received.answers[0] ? {
      authorized: received.answers.find((item) => item.input?.context?.scope === 'selection')?.token === `Bearer ${token}`,
      action: received.answers.find((item) => item.input?.context?.scope === 'selection')?.input?.action,
      scope: received.answers.find((item) => item.input?.context?.scope === 'selection')?.input?.context?.scope,
      hasSelection: Boolean(received.answers.find((item) => item.input?.context?.scope === 'selection')?.input?.context?.selection?.quote),
    } : null,
    sessionSync: received.sessions[0] ? { authorized: received.sessions[0].token === `Bearer ${token}`, hasDocument: Boolean(received.sessions[0].input?.document?.url) } : null,
    insightSave: received.saves[0] ? {
      authorized: received.saves[0].token === `Bearer ${token}`,
      hasSource: Boolean(received.saves[0].input?.url && received.saves[0].input?.quote),
      idempotencyKeyIsUuid: /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(String(received.saves[0].input?.idempotencyKey || '')),
    } : null,
    revoke: received.revokes[0] ? { authorized: received.revokes[0].token === `Bearer ${token}` } : null,
    liveEngine: received.liveEngine,
    liveEngineAnswer: liveAnswerText.slice(0, 700),
    tokenClearedAfterDisconnect: !stored.readerToken,
    platformUrlStored: stored.readerPlatformUrl,
  };
  if (
    !summary.pkceExchange?.validPkce
    || !summary.dockSummary?.authorized
    || summary.dockSummary.action !== 'ask'
    || summary.dockSummary.scope !== 'page'
    || !summary.dockSummary.prompt.includes('核心结论')
    || !summary.platformAnswer?.authorized
    || summary.platformAnswer.action !== 'explain'
    || summary.platformAnswer.scope !== 'selection'
    || !summary.platformAnswer.hasSelection
    || !summary.sessionSync?.authorized
    || !summary.insightSave?.authorized
    || !summary.insightSave?.hasSource
    || !summary.insightSave?.idempotencyKeyIsUuid
    || !summary.revoke?.authorized
    || !summary.tokenClearedAfterDisconnect
    || (liveEngineUrl && (!summary.liveEngine?.provider || !summary.liveEngine?.model || summary.liveEngine.outputTokens <= 0))
  ) {
    throw new Error(`platform PKCE E2E assertion failed: ${JSON.stringify(summary)}`);
  }
  console.log(JSON.stringify(summary, null, 2));
} finally {
  await context.close();
  await new Promise((resolve) => server.close(resolve));
}
