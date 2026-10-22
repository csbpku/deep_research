import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, cp, readFile, writeFile } from 'node:fs/promises';
import { chromium } from '../../web/node_modules/@playwright/test/index.mjs';

const root = await mkdtemp('/private/tmp/reader-web-search-');
let searches = 0; let searchMode = 'searched'; let answers = []; let standalonePlans = 0; const networkRequests = [];
const source = { title: 'Official library release notes', url: 'https://example.org/releases', snippet: 'The latest release adds a bounded queue.' };
const server = createServer(async (req, res) => {
  res.setHeader('access-control-allow-origin', '*');
  if (req.url === '/article') { res.setHeader('content-type', 'text/html'); res.end('<article><h1>Library architecture</h1><p>A queue feeds two workers.</p><p>The queue bounds memory usage.</p></article>'); return; }
  let raw = ''; for await (const chunk of req) raw += chunk;
  if (req.url === '/v1/chat/completions') {
    const payload = JSON.parse(raw);
    const planning = payload.messages?.[0]?.content?.includes('Decide whether this reading follow-up');
    if (planning) { standalonePlans++; res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ choices: [{ message: { content: '{"query":"React documentation"}' } }] })); return; }
    const content = JSON.stringify({ answer: 'Standalone answer with external context [W1].', evidence: [], limitations: [] });
    if (payload.stream) { res.setHeader('content-type', 'text/event-stream'); res.end(`data: ${JSON.stringify({ choices: [{ delta: { content } }] })}\n\ndata: [DONE]\n\n`); }
    else { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ choices: [{ message: { content } }] })); }
    return;
  }
  if (req.url === '/api/reading/search') {
    searches++; const payload = JSON.parse(raw); assert.deepEqual(Object.keys(payload).sort(), ['question', 'title']);
    await new Promise(resolve => setTimeout(resolve, searchMode === 'slow' ? 4000 : 450));
    if (searchMode === 'failed') { res.writeHead(503); res.end('{}'); return; }
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ status: searchMode === 'skipped' ? 'skipped' : 'searched', sources: searchMode === 'skipped' ? [] : [source] })); return;
  }
  if (req.url === '/api/reading/answer/stream') {
    const payload = JSON.parse(raw); answers.push(payload);
    const n = answers.length;
    res.setHeader('content-type', 'text/event-stream');
    res.write('event: progress\ndata: {"done":1,"total":1,"phase":"analyzing"}\n\n');
    await new Promise(resolve => setTimeout(resolve, 300));
    const reading = { answer: `Answer ${n}. A queue feeds two workers [1].${payload.webContext?.includes('[W1]') ? ' Release notes provide external context [W1].' : ''}`, evidence: [{ quote: 'A queue feeds two workers.', claim: 'Queue flow' }], warnings: [] };
    res.end(`event: done\ndata: ${JSON.stringify({ reading })}\n\n`); return;
  }
  res.setHeader('content-type', 'application/json'); res.end('{}');
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
const extension = `${root}/extension`;
await cp(new URL('../.output/chrome-mv3', import.meta.url).pathname, extension, { recursive: true });
const manifest = JSON.parse(await readFile(`${extension}/manifest.json`, 'utf8'));
manifest.host_permissions.push('http://127.0.0.1/*', 'https://search.brave.com/*', 'https://www.bing.com/*');
await writeFile(`${extension}/manifest.json`, JSON.stringify(manifest));
const context = await chromium.launchPersistentContext(`${root}/profile`, {
  executablePath: process.env.CHROME_FOR_TESTING || '/Users/shaobo.chen/Library/Caches/ms-playwright/chromium-1234/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing',
  headless: true, locale: 'en', viewport: { width: 380, height: 860 },
  args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`],
});
await context.route('https://search.brave.com/**', async route => {
  networkRequests.push({ url: route.request().url(), headers: route.request().headers() });
  await route.fulfill({ status: 200, contentType: 'text/html', body: '<div data-type="web"><a href="https://react.dev/learn"><div class="title snippet">React official docs</div></a><div class="content snippet">React builds interfaces from components.</div></div>' });
});
try {
  const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
  const id = new URL(worker.url()).host;
  const article = await context.newPage(); await article.goto(`${origin}/article`);
  const panel = await context.newPage(); await panel.goto(`chrome-extension://${id}/sidepanel.html`);
  await panel.waitForFunction(() => document.documentElement.dataset.readerReady === 'true');
  await panel.evaluate(async origin => {
    await chrome.storage.local.set({ readerToken: 'test-token', readerTokenOrigin: origin, readerPlatformUrl: origin });
    const request = indexedDB.open('deep-research-reader');
    await new Promise((resolve, reject) => { request.onerror = () => reject(request.error); request.onsuccess = () => {
      const db = request.result; const tx = db.transaction('settings', 'readwrite');
      tx.objectStore('settings').put({ id: 'readingMode', value: 'platform' });
      tx.objectStore('settings').put({ id: 'platformUrl', value: origin });
      tx.oncomplete = () => { db.close(); resolve(); };
    }; });
  }, origin);
  await panel.reload(); await panel.waitForFunction(() => document.documentElement.dataset.readerReady === 'true');
  await article.bringToFront();
  const tabId = await worker.evaluate(async url => (await chrome.tabs.query({ url }))[0].id, article.url());
  async function readArticle() {
    await worker.evaluate(async tabId => {
      await chrome.scripting.executeScript({ target: { tabId }, files: ['content.js'] });
      await chrome.tabs.sendMessage(tabId, { type: 'deep-research:request-page' });
    }, tabId);
    await panel.locator('#persistent-composer').waitFor({ state: 'visible' });
  }
  await readArticle();
  const toggle = panel.locator('#web-search-toggle');
  assert.equal(await toggle.getAttribute('aria-pressed'), 'false');
  async function ask(question, expected) {
    await panel.locator('#question-input').fill(question); await panel.locator('#send-question').click();
    await panel.locator('#conversation-list').getByText(`Answer ${expected}.`, { exact: false }).waitFor({ timeout: 15000 });
    await panel.locator('#stop-answer').waitFor({ state: 'hidden' });
  }
  await ask('Explain the queue.', 1); assert.equal(searches, 0, 'default off performs no search');
  await toggle.click(); await panel.waitForFunction(() => document.getElementById('web-search-toggle').getAttribute('aria-pressed') === 'true');
  await panel.locator('#question-input').fill('What is the latest release?'); await panel.locator('#send-question').click();
  await panel.getByText('Checking whether web search is needed…', { exact: true }).waitFor();
  await panel.locator('#conversation-list').getByText('Answer 2.', { exact: false }).waitFor();
  assert.equal(searches, 1);
  assert.match(answers[1].webContext, /\[W1\]/u);
  assert.equal(answers[1].context.body.includes('latest release'), false, 'network snippets never become original text');
  assert.equal(await panel.locator('.answer-web-sources a').getAttribute('href'), source.url);
  assert.equal(await panel.locator('.answer-web-sources a').getAttribute('rel'), 'noopener noreferrer');
  await panel.locator('.answer-web-sources').last().scrollIntoViewIfNeeded();
  await panel.screenshot({ path: `${root}/web-search-en.png`, fullPage: true });
  searchMode = 'skipped'; await ask('Explain the queue again.', 3);
  assert.equal(searches, 2); assert.ok(!answers[2].webContext.includes('[W1]'));
  assert.ok(answers[2].history.some(turn => turn.content.includes(source.url)), 'follow-ups retain prior source URLs as historical context');
  assert.equal(await panel.locator('.answer-web-sources').count(), 1, 'previous turn keeps its own sources');
  searchMode = 'failed'; await ask('Verify the current release.', 4);
  await panel.getByText('Web search was unavailable. This answer uses the original page; current web information was not verified.', { exact: true }).first().waitFor();
  assert.match(answers[3].webContext, /search was unavailable/u);
  const beforeSummarySearches = searches;
  await panel.locator('#chat-summary').click();
  await panel.locator('#conversation-list').getByText('Answer 5.', { exact: false }).waitFor();
  assert.equal(searches, beforeSummarySearches, 'summary shortcut never searches');
  searchMode = 'slow'; const before = answers.length;
  await panel.locator('#question-input').fill('Search current alternatives.'); await panel.locator('#send-question').click();
  await panel.locator('#stop-answer').waitFor({ state: 'visible' }); await panel.locator('#stop-answer').click();
  await panel.locator('#stop-answer').waitFor({ state: 'hidden' }); assert.equal(answers.length, before, 'stopping search does not start an answer');
  await panel.reload(); await panel.waitForFunction(() => document.documentElement.dataset.readerReady === 'true'); await readArticle();
  assert.equal(await toggle.getAttribute('aria-pressed'), 'true', 'preference survives panel reload');
  await panel.locator('.answer-web-sources a').waitFor();
  // Sidebar history is exercised separately; the persisted session must retain per-turn source metadata.
  const saved = await worker.evaluate(async () => { const request = indexedDB.open('deep-research-reader'); return new Promise(resolve => { request.onsuccess = () => { const db = request.result; const read = db.transaction('sessions').objectStore('sessions').getAll(); read.onsuccess = () => { resolve(read.result); db.close(); }; }; }); });
  assert.ok(saved.some(session => session.discussion?.some(turn => turn.webSources?.[0]?.url === source.url)));
  assert.equal(await panel.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, 'no horizontal overflow at 380px');
  const mui = await toggle.getAttribute('class'); assert.match(mui, /MuiButton/u);
  await panel.evaluate(() => chrome.storage.local.set({ readerUiLanguage: 'zh-CN' }));
  await panel.reload(); await panel.waitForFunction(() => document.documentElement.dataset.readerReady === 'true'); await readArticle();
  assert.match(await toggle.innerText(), /联网补充/u);
  await panel.locator('.answer-web-sources').last().scrollIntoViewIfNeeded();
  await panel.screenshot({ path: `${root}/web-search-zh.png`, fullPage: true });
  await panel.evaluate(async origin => {
    const request = indexedDB.open('deep-research-reader');
    await new Promise(resolve => { request.onsuccess = () => {
      const db = request.result; const tx = db.transaction('settings', 'readwrite');
      tx.objectStore('settings').put({ id: 'readingMode', value: 'local' });
      tx.objectStore('settings').put({ id: 'provider', value: { providerKind: 'custom', baseUrl: `${origin}/v1`, model: 'standalone-test', apiKey: 'standalone-private-key' } });
      tx.oncomplete = () => { db.close(); resolve(); };
    }; });
  }, origin);
  await article.bringToFront(); await panel.reload(); await panel.waitForFunction(() => document.documentElement.dataset.readerReady === 'true'); await readArticle();
  await panel.locator('#question-input').fill('Find the current React documentation.'); await panel.locator('#send-question').click();
  await panel.locator('#conversation-list').getByText('Standalone answer with external context', { exact: false }).waitFor({ timeout: 15000 });
  assert.equal(standalonePlans, 1);
  assert.equal(networkRequests.length, 1);
  assert.equal(networkRequests[0].headers.authorization, undefined, 'search request has no model API key');
  assert.equal(new URL(networkRequests[0].url).searchParams.get('q'), 'React documentation');
  assert.equal(await panel.locator('.answer-web-sources a').last().getAttribute('href'), 'https://react.dev/learn');
  console.log(JSON.stringify({ ok: true, standalonePlans, standaloneSearches: networkRequests.length, searches, answers: answers.length, screenshot: `${root}/web-search-en.png`, root }));
} finally { await context.close(); await new Promise(resolve => server.close(resolve)); }
