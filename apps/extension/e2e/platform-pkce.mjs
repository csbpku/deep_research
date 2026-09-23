import { createHash, randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
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
const authorizationCodes = new Map();
const received = { requests: [], exchanges: [], answers: [], sessions: [], saves: [], revokes: [] };

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
    response.end('<!doctype html><title>Mock login</title><p>Mock login completed. The test will follow the extension callback.</p>');
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
    json(response, auth === `Bearer ${token}` ? 201 : 401, { ok: auth === `Bearer ${token}`, deduplicated: false, draft: { id: 'draft-test', status: 'draft' } });
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

const extensionPath = new URL('../.output/chrome-mv3', import.meta.url).pathname;
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
  args: ['--enable-extensions', `--disable-extensions-except=${extensionPath}`, `--load-extension=${extensionPath}`, '--no-first-run', '--no-default-browser-check'],
});

try {
  const serviceWorker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
  const extensionId = new URL(serviceWorker.url()).host;
  const page = await context.newPage();
  await page.goto(`http://127.0.0.1:${port}/fixture.html`, { waitUntil: 'domcontentloaded' });
  await page.bringToFront();
  const panel = await context.newPage();
  await panel.goto(`chrome-extension://${extensionId}/sidepanel.html`, { waitUntil: 'domcontentloaded' });
  await page.bringToFront();
  await serviceWorker.evaluate(async () => {
    const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    if (!tab?.id) throw new Error('fixture tab is not active');
    await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['content.js'] });
    await chrome.tabs.sendMessage(tab.id, { type: 'deep-research:request-page' });
  });
  await panel.waitForFunction(() => Boolean(document.querySelector('#page-source')?.textContent), null, { timeout: 10_000 });

  await panel.bringToFront();
  await panel.locator('#settings-button').click();
  await panel.locator('#mode-platform').click();
  await panel.waitForFunction(() => document.querySelector('#storage-status')?.textContent === '平台模式', null, { timeout: 5_000 });
  await panel.locator('#platform-url').fill(`http://127.0.0.1:${port}`);
  await panel.locator('#connect-platform').click();
  for (let attempt = 0; attempt < 30 && authorizationCodes.size === 0; attempt += 1) await new Promise((resolve) => setTimeout(resolve, 100));
  const [code, record] = authorizationCodes.entries().next().value || [];
  if (!code || !record) throw new Error(`mock authorization page was not opened: ${JSON.stringify(received.requests)}`);
  const callback = new URL(record.redirect);
  callback.searchParams.set('code', code);
  callback.searchParams.set('state', record.state);
  const callbackPage = await context.newPage();
  await callbackPage.goto(callback.toString(), { waitUntil: 'domcontentloaded' });
  await panel.locator('#platform-status').waitFor({ state: 'visible', timeout: 15_000 });
  try {
    await panel.waitForFunction(() => document.querySelector('#platform-status')?.textContent?.includes('已连接'), null, { timeout: 15_000 });
  } catch (error) {
    throw new Error(`platform connect failed: ${JSON.stringify({ status: await panel.locator('#platform-status').innerText().catch(() => ''), body: (await panel.locator('body').innerText().catch(() => '')).slice(-1000), requests: received.requests, exchanges: received.exchanges, pages: context.pages().map((item) => item.url()) })}; ${error.message}`);
  }

  // Exercise the explicit knowledge path after the account connection:
  // select source text, review the local save dialog, then send the confirmed
  // insight to the optional research-library endpoint.
  await panel.locator('#close-settings').click();
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
  await panel.bringToFront();
  await panel.locator('#save-selection').click();
  await panel.locator('#save-dialog').waitFor({ state: 'visible', timeout: 10_000 });
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
  await panel.locator('#sync-selection').click();
  await panel.waitForFunction(() => document.querySelector('#notice')?.textContent?.includes('同步到 Deep Research'), null, { timeout: 10_000 });

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
    platformAnswer: received.answers[0] ? {
      authorized: received.answers[0].token === `Bearer ${token}`,
      action: received.answers[0].input?.action,
      scope: received.answers[0].input?.context?.scope,
      hasSelection: Boolean(received.answers[0].input?.context?.selection?.quote),
    } : null,
    sessionSync: received.sessions[0] ? { authorized: received.sessions[0].token === `Bearer ${token}`, hasDocument: Boolean(received.sessions[0].input?.document?.url) } : null,
    insightSave: received.saves[0] ? {
      authorized: received.saves[0].token === `Bearer ${token}`,
      hasSource: Boolean(received.saves[0].input?.url && received.saves[0].input?.quote),
      idempotencyKeyIsUuid: /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(String(received.saves[0].input?.idempotencyKey || '')),
    } : null,
    revoke: received.revokes[0] ? { authorized: received.revokes[0].token === `Bearer ${token}` } : null,
    tokenClearedAfterDisconnect: !stored.readerToken,
    platformUrlStored: stored.readerPlatformUrl,
  };
  if (
    !summary.pkceExchange?.validPkce
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
  ) {
    throw new Error(`platform PKCE E2E assertion failed: ${JSON.stringify(summary)}`);
  }
  console.log(JSON.stringify(summary, null, 2));
} finally {
  await context.close();
  await new Promise((resolve) => server.close(resolve));
}
