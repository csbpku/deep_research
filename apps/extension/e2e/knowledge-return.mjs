import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { cp, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { chromium } from '../../web/node_modules/@playwright/test/index.mjs';
import { join } from 'node:path';
import { tempDir, tempPath } from './temp-paths.mjs';

// Test-only copies and fresh profiles: never install into the user's browser
// or alter the production build. Every application endpoint is a local mock.
const directory = await mkdtemp(join(tempDir(), 'reader-knowledge-return-'));
const builtExtension = new URL('../.output/chrome-mv3', import.meta.url).pathname;
const executablePath = process.env.CHROME_FOR_TESTING || [
  '/Users/shaobo.chen/Library/Caches/ms-playwright/chromium-1234/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
].find(existsSync);
assert.ok(executablePath, 'Chrome for Testing must already be installed');
const radarId = '60000000-0000-4000-8000-000000000001';
const remoteId = '60000000-0000-4000-8000-000000000002';
const savedId = '60000000-0000-4000-8000-000000000003';
const localId = '60000000-0000-4000-8000-000000000004';
const fixture = (await readFile(new URL('./fixture.html', import.meta.url), 'utf8'))
  .replace(/<script>[\s\S]*?<\/script>/u, '');
const requests = [];
const aiRequests = [];
const errors = [];
let origin;
let delayRecall = false;
const pendingRecalls = [];
const judgement = () => ({
  id: remoteId, title: 'Previous platform judgement', conclusion: 'Confirmed platform AI judgement: verify queue capacity against latency.',
  status: 'draft', updatedAt: '2026-10-20T06:00:00.000Z', url: `${origin}/article`, radarSummaryId: radarId,
});
const server = createServer(async (request, response) => {
  const url = new URL(request.url, origin || 'http://127.0.0.1');
  response.setHeader('access-control-allow-origin', '*');
  response.setHeader('access-control-allow-headers', 'authorization, content-type');
  response.setHeader('access-control-allow-methods', 'GET, POST, PUT, OPTIONS');
  if (request.method === 'OPTIONS') { response.writeHead(204).end(); return; }
  let raw = '';
  for await (const chunk of request) raw += chunk;
  requests.push({ path: url.pathname, method: request.method, url: url.toString(), authorization: request.headers.authorization, body: raw ? JSON.parse(raw) : null });
  const json = value => { response.setHeader('content-type', 'application/json'); response.end(JSON.stringify(value)); };
  if (/answer|translate|chat\/completions|\/models/u.test(url.pathname)) {
    aiRequests.push(url.pathname); response.statusCode = 500; json({ message: 'AI forbidden in this acceptance test' }); return;
  }
  if (url.pathname === '/api/radar') { json({ items: [{ id: radarId, title: 'Mock radar source', url: `${origin}/article` }] }); return; }
  if (url.pathname.startsWith('/radar/')) {
    const source = `${origin}/article?deep-research-source=radar&deep-research-summary=${radarId}&deep-research-platform=${encodeURIComponent(origin)}`;
    response.setHeader('content-type', 'text/html; charset=utf-8');
    response.end(`<!doctype html><meta charset="utf-8"><title>Mock radar</title><button onclick='window.open(${JSON.stringify(source)}, "_blank")'>打开原文</button>`);
    return;
  }
  if (url.pathname === '/article' || url.pathname === '/other') {
    response.setHeader('content-type', 'text/html; charset=utf-8'); response.end(fixture); return;
  }
  if (url.pathname === '/api/reading/save' && request.method === 'GET') {
    const reply = () => { response.setHeader('cache-control', 'private, no-store'); json({ items: [judgement()] }); };
    if (delayRecall) pendingRecalls.push(reply); else reply();
    return;
  }
  if (url.pathname === '/api/reading/save') { json({ ok: true, draft: { id: savedId, status: 'draft' } }); return; }
  if (url.pathname === '/api/reading/session') { json(request.method === 'GET' ? { sessions: [] } : { ok: true }); return; }
  if (url.pathname === '/api/reading/token/revoke' || url.pathname === '/healthz') { json({ ok: true }); return; }
  if (url.pathname.startsWith('/researches/')) {
    response.setHeader('content-type', 'text/html'); response.end('<h1>Mock saved knowledge</h1>'); return;
  }
  if (url.pathname === '/favicon.ico') { response.writeHead(204).end(); return; }
  response.statusCode = 404; json({ message: 'Unexpected mock route' });
});
await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
origin = `http://127.0.0.1:${server.address().port}`;

async function runExistingRadar(extension) {
  const runner = (await readFile(new URL('./radar-reader-flow.mjs', import.meta.url), 'utf8'))
    .replace("const extensionPath = new URL('../.output/chrome-mv3', import.meta.url).pathname;", `const extensionPath = ${JSON.stringify(extension)};`)
    .replace("  await panel.getByRole('button', { name: '启用此站点' }).click();", "  await source.bringToFront();\n  await panel.getByRole('button', { name: '启用此站点' }).click();");
  // Only adapt the runner's fixture path and active source tab. A panel
  // opened as a test tab must not make source messages look like background
  // activity; the real sidepanel never replaces the active article tab.
  const child = spawn(process.execPath, ['--input-type=module', '--eval', runner], {
    cwd: new URL('.', import.meta.url).pathname,
    env: { ...process.env, READER_PLATFORM_URL: origin, READER_HEADLESS: '1', CHROME_FOR_TESTING: executablePath },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  for (const stream of [child.stdout, child.stderr]) stream.on('data', chunk => { output = (output + chunk.toString()).slice(-16000); });
  const timer = setTimeout(() => child.kill('SIGTERM'), 65_000);
  try {
    const code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', resolve); });
    return { ok: code === 0, code, output };
  } finally { clearTimeout(timer); }
}

let context;
let panel;
const report = { directory, origin, aiRequests, errors };
try {
  const extension = `${directory}/extension`;
  await cp(builtExtension, extension, { recursive: true });
  const manifest = JSON.parse(await readFile(`${extension}/manifest.json`, 'utf8'));
  manifest.host_permissions = [...new Set([...manifest.host_permissions, 'http://127.0.0.1/*'])];
  await writeFile(`${extension}/manifest.json`, JSON.stringify(manifest));
  report.existingRadar = await runExistingRadar(extension);
  console.log(`Radar mock acceptance: ${report.existingRadar.ok ? 'passed' : 'failed'}`);
  context = await chromium.launchPersistentContext(`${directory}/profile`, {
    executablePath, headless: true, locale: 'zh-CN', viewport: { width: 420, height: 1000 },
    args: ['--enable-extensions', `--disable-extensions-except=${extension}`, `--load-extension=${extension}`,
      '--disable-background-networking', '--no-first-run', '--no-default-browser-check'],
  });
  context.setDefaultTimeout(8_000);
  context.setDefaultNavigationTimeout(12_000);
  const blocked = [];
  await context.route('**/*', route => {
    const url = new URL(route.request().url());
    if (['chrome-extension:', 'data:', 'blob:'].includes(url.protocol) || url.origin === origin) return route.continue();
    blocked.push(url.origin); return route.abort();
  });
  const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker', { timeout: 10_000 });
  const extensionId = new URL(worker.url()).host;
  const article = await context.newPage();
  await article.goto(`${origin}/article?utm_source=radar&deep-research-source=radar&deep-research-summary=${radarId}&deep-research-platform=${encodeURIComponent(origin)}#intro`);
  const tabId = await worker.evaluate(async url => (await chrome.tabs.query({})).find(tab => tab.url === url)?.id, article.url());
  assert.ok(tabId, 'the isolated article tab must be discoverable');
  panel = await context.newPage();
  panel.on('pageerror', error => errors.push(error.message));
  const panelUrl = `chrome-extension://${extensionId}/sidepanel.html?sourceTab=${tabId}`;
  await panel.goto(panelUrl);
  await panel.waitForFunction(() => document.documentElement.dataset.readerReady === 'true');
  await panel.evaluate(async ({ origin, localId, radarId }) => {
    await chrome.storage.local.set({ readerUiLanguage: 'zh-CN', readerPlatformUrl: origin });
    const db = await new Promise((resolve, reject) => {
      const request = indexedDB.open('deep-research-reader', 4);
      request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error);
    });
    const tx = db.transaction(['settings', 'insights', 'annotations', 'sessions'], 'readwrite');
    const settings = tx.objectStore('settings');
    settings.put({ id: 'platformUrl', value: origin });
    settings.put({ id: 'readingMode', value: 'local' });
    settings.put({ id: 'provider', value: { providerKind: 'custom', baseUrl: `${origin}/v1`, model: 'mock-never-called', apiKey: 'fake-local-only' } });
    tx.objectStore('insights').put({ id: localId, title: 'Previous local judgement', url: `${origin}/article`,
      document: { url: `${origin}/article`, version: null }, quote: 'Bounded queues keep browser work responsive.',
      note: 'Confirmed local judgement: bound concurrency.', createdAt: '2026-10-19T06:00:00Z' });
    tx.objectStore('insights').put({ id: 'unrelated', title: 'Unrelated query variant', url: `${origin}/article?edition=other`,
      quote: 'MUST_NOT_RECALL_OTHER_QUERY', note: 'MUST_NOT_RECALL_OTHER_QUERY', createdAt: '2026-10-20T08:00:00Z' });
    tx.objectStore('annotations').put({ id: 'old-note', document: { url: `${origin}/article`, title: 'Previous source note', version: 'old-version' },
      anchor: { quote: 'A document pipeline should preserve the source structure.' }, note: 'Confirmed source note: retain source structure.', createdAt: '2026-10-18T06:00:00Z' });
    const url = `${origin}/article?utm_source=radar`;
    tx.objectStore('sessions').put({ id: `${url}::old-version`, url, version: 'old-version', radarSummaryId: radarId,
      answer: 'UNCONFIRMED_CHAT_MUST_NOT_BECOME_KNOWLEDGE',
      discussion: [{ role: 'assistant', content: 'UNCONFIRMED_CHAT_MUST_NOT_BECOME_KNOWLEDGE' }], updatedAt: '2026-10-19T05:00:00Z' });
    await new Promise((resolve, reject) => { tx.oncomplete = resolve; tx.onerror = () => reject(tx.error); });
    db.close();
  }, { origin, localId, radarId });
  await panel.reload();
  await panel.waitForFunction(() => document.documentElement.dataset.readerReady === 'true');
  await article.bringToFront();
  await worker.evaluate(async tabId => {
    await chrome.scripting.executeScript({ target: { tabId }, files: ['content.js'] });
    await chrome.tabs.sendMessage(tabId, { type: 'deep-research:request-page' });
  }, tabId);
  const knowledge = panel.locator('#page-knowledge');
  const cards = knowledge.locator('article');
  await knowledge.waitFor({ state: 'visible' });
  await panel.waitForFunction(() => document.querySelectorAll('#page-knowledge-list article').length === 2);
  // The card is collapsed by default so it cannot squeeze the centred
  // first-run conversation. The count on its label is what makes recall
  // visible without expanding, and the records stay one click away.
  const summary = knowledge.locator('#page-knowledge-disclosure .MuiAccordionSummary-content');
  assert.equal((await summary.innerText()).trim(), '本页已保存 · 2');
  await summary.click();
  assert.match(await knowledge.innerText(), /Confirmed local judgement/);
  assert.match(await knowledge.innerText(), /Confirmed source note/);
  assert.doesNotMatch(await knowledge.innerText(), /UNCONFIRMED_CHAT|MUST_NOT_RECALL_OTHER_QUERY/);
  assert.equal(requests.filter(item => item.path === '/api/reading/save' && item.method === 'GET').length, 0, 'offline must not query platform');
  assert.equal(await knowledge.getByText('旧版本', { exact: true }).count(), 1);
  await knowledge.screenshot({ path: `${directory}/offline-local-420.png` });
  report.offlineLocalOnly = true;
  console.log('Offline confirmed-only recall: passed');

  await panel.evaluate(async origin => {
    await chrome.storage.local.set({ readerToken: 'fake-bound-token', readerTokenOrigin: origin, readerPlatformUrl: origin });
  }, origin);
  await worker.evaluate(() => chrome.runtime.sendMessage({ type: 'deep-research:connection-state', connected: true }));
  await panel.waitForFunction(() => document.querySelector('#page-knowledge-list')?.textContent?.includes('Confirmed platform AI judgement'));
  assert.equal(await cards.count(), 3);
  const recall = requests.find(item => item.path === '/api/reading/save' && item.method === 'GET');
  assert.equal(recall.authorization, 'Bearer fake-bound-token');
  assert.equal(new URL(recall.url).searchParams.get('url'), `${origin}/article?utm_source=radar#intro`);
  await knowledge.screenshot({ path: `${directory}/connected-judgements-420.png` });
  await panel.screenshot({ path: `${directory}/panel-420.png` });
  await panel.setViewportSize({ width: 1100, height: 900 });
  assert.ok(await panel.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'desktop has no horizontal overflow');
  await knowledge.screenshot({ path: `${directory}/connected-judgements-1100.png` });
  await panel.setViewportSize({ width: 420, height: 1000 });
  assert.ok(await panel.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'sidepanel has no horizontal overflow');
  const remote = cards.filter({ hasText: 'Previous platform judgement' });
  const [research] = await Promise.all([
    context.waitForEvent('page'),
    remote.getByRole('button', { name: '研究库', exact: true }).click(),
  ]);
  await research.waitForLoadState('domcontentloaded');
  assert.equal(research.url(), `${origin}/researches/${remoteId}`);
  await research.close();
  report.connectedRecallAndSourceLink = true;
  console.log('Connected recall, links and screenshots: passed');

  await cards.filter({ hasText: 'Previous local judgement' }).getByRole('button', { name: '编辑', exact: true }).click();
  await panel.locator('#save-note').fill('Edited original local judgement.');
  await panel.locator('#confirm-save').click();
  const local = await panel.evaluate(async localId => {
    const request = indexedDB.open('deep-research-reader');
    const db = await new Promise(resolve => { request.onsuccess = () => resolve(request.result); });
    const row = await new Promise(resolve => { const read = db.transaction('insights').objectStore('insights').get(localId); read.onsuccess = () => resolve(read.result); });
    db.close(); return row;
  }, localId);
  assert.ok(!local.radarSummaryId, 'editing an old insight must not attach the current radar');
  assert.equal(local.document.version, null, 'editing must not attach the current document version');
  report.editProvenancePreserved = true;

  await panel.locator('#settings-button').click();
  await panel.locator('#mode-platform').click();
  await panel.locator('#close-settings').click();
  await article.bringToFront();
  await article.locator('#target').evaluate(node => {
    const range = document.createRange(); range.selectNodeContents(node);
    const selection = getSelection(); selection.removeAllRanges(); selection.addRange(range);
    node.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
  });
  await panel.locator('#save-selection').waitFor({ state: 'visible' });
  await panel.locator('#save-selection').click();
  await panel.locator('#save-note').fill('New confirmed radar judgement.');
  await panel.locator('#confirm-save').click();
  await panel.waitForFunction(() => document.querySelector('#notice')?.textContent?.includes('已同步'));
  const write = requests.find(item => item.path === '/api/reading/save' && item.method === 'POST');
  assert.equal(write.body.radarSummaryId, radarId);
  const synced = await panel.evaluate(async () => {
    const request = indexedDB.open('deep-research-reader');
    const db = await new Promise(resolve => { request.onsuccess = () => resolve(request.result); });
    const rows = await new Promise(resolve => { const read = db.transaction('insights').objectStore('insights').getAll(); read.onsuccess = () => resolve(read.result); });
    db.close(); return rows.find(row => row.note === 'New confirmed radar judgement.');
  });
  assert.equal(synced.platformResearchId, savedId);
  assert.equal(synced.platformOrigin, origin);
  assert.equal(synced.radarSummaryId, radarId);
  report.captureAndSyncIdentity = true;

  // Hold the server response across a page change. The client must cancel or
  // ignore it, never render the original page's knowledge on a different URL.
  delayRecall = true;
  await panel.locator('#nav-library').click();
  await panel.locator('#refresh-library').click();
  await panel.waitForTimeout(100);
  await article.goto(`${origin}/other`);
  await worker.evaluate(async tabId => {
    await chrome.scripting.executeScript({ target: { tabId }, files: ['content.js'] });
    await chrome.tabs.sendMessage(tabId, { type: 'deep-research:request-page' });
  }, tabId);
  await panel.waitForFunction(origin => document.querySelector('#page-source')?.textContent === `${origin}/other`, origin);
  await panel.locator('#nav-chat').click();
  delayRecall = false;
  pendingRecalls.splice(0).forEach(reply => reply());
  await panel.waitForTimeout(200);
  assert.ok(await knowledge.isHidden(), 'old-page late results must not render on an unrelated URL');
  report.pageRaceRejected = true;

  await panel.locator('#settings-button').click();
  await panel.locator('#disconnect-platform').click();
  await panel.waitForFunction(() => document.querySelector('#platform-status')?.textContent?.includes('已断开'));
  const readsAfterDisconnect = requests.filter(item => item.path === '/api/reading/save' && item.method === 'GET').length;
  await panel.locator('#close-settings').click();
  await panel.locator('#nav-library').click();
  await panel.locator('#refresh-library').click();
  await panel.waitForTimeout(250);
  assert.equal(requests.filter(item => item.path === '/api/reading/save' && item.method === 'GET').length, readsAfterDisconnect);
  report.disconnectedPrivate = true;
  report.blockedExternalOrigins = blocked;
  assert.equal(aiRequests.length, 0, 'no AI calls, including mock AI calls, are permitted');
  assert.deepEqual(errors, [], 'no extension page runtime errors');
  assert.equal(report.existingRadar.ok, true, `Existing radar acceptance failed: ${report.existingRadar.output}`);
  report.ok = true;
} catch (error) {
  report.ok = false;
  report.failure = String(error.stack || error);
  if (panel && !panel.isClosed()) {
    report.panelText = (await panel.locator('body').innerText().catch(() => '')).slice(-5000);
    await panel.screenshot({ path: `${directory}/failure.png` }).catch(() => {});
  }
  process.exitCode = 1;
} finally {
  delayRecall = false;
  pendingRecalls.splice(0).forEach(reply => reply());
  await context?.close().catch(() => {});
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
  report.requestCounts = requests.reduce((counts, item) => {
    const key = `${item.method} ${item.path}`; counts[key] = (counts[key] || 0) + 1; return counts;
  }, {});
  await writeFile(`${directory}/report.json`, JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
}
