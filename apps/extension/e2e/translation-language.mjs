import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { cp, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { chromium } from '../../web/node_modules/@playwright/test/index.mjs';

const directory = await mkdtemp('/private/tmp/reader-language-');
const requests = [];
const extraParagraphs = Array.from({ length: 48 }, (_, i) => `<p>Section ${i + 1}: The queue preserves source context while each worker translates a complete paragraph.</p>`).join('');
const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="400" height="180"><rect width="400" height="180" fill="white"/><text x="40" y="85" font-size="30">Queue → Workers</text></svg>';
const server = createServer(async (req, res) => {
  res.setHeader('access-control-allow-origin', '*');
  if (req.url === '/diagram.svg') { res.setHeader('content-type', 'image/svg+xml'); res.end(svg); return; }
  if (req.url === '/article') { res.setHeader('content-type', 'text/html'); res.end(`<article><h1>Worker architecture</h1><p>A queue feeds two workers.</p>${extraParagraphs}<img src="/diagram.svg" alt="Queue to workers diagram"></article>`); return; }
  let raw = ''; for await (const chunk of req) raw += chunk;
  if (req.url === '/api/reading/translate') {
    const input = JSON.parse(raw); requests.push({ type: 'text', ...input });
    await new Promise(resolve => setTimeout(resolve, 250));
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ translations: input.blocks.map(block => ({ id: block.id, text: `[${input.language}] ${block.text}` })) }));
  } else if (req.url === '/api/reading/translate-image') {
    const input = JSON.parse(raw); requests.push({ type: 'image', ...input });
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ hasReadableText: true, regions: [], confidence: 1, fallbackTranslation: `[${input.language}] Queue to workers` }));
  } else if (req.url === '/api/reading/answer/stream') {
    const input = JSON.parse(raw); requests.push({ type: 'answer', ...input });
    res.setHeader('content-type', 'text/event-stream');
    res.end(`event: done\ndata: ${JSON.stringify({ reading: { answer: input.prompt.includes('in ja') ? '日本語の翻訳' : 'An English answer.', evidence: [], limitations: [] } })}\n\n`);
  } else if (req.url === '/api/reading/answer-image') {
    requests.push(JSON.parse(raw));
    await new Promise(resolve => setTimeout(resolve, 500));
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ suggestion: JSON.stringify({ answer: `The queue feeds the workers. Turn ${requests.length}.`, evidence: [{ quote: 'A queue feeds two workers.', claim: 'Queue flow' }], limitations: [] }) }));
  } else { res.setHeader('content-type', 'application/json'); res.end('{}'); }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
const extension = `${directory}/extension`;
await cp(new URL('../.output/chrome-mv3', import.meta.url).pathname, extension, { recursive: true });
const manifest = JSON.parse(await readFile(`${extension}/manifest.json`, 'utf8'));
manifest.host_permissions.push('http://127.0.0.1/*');
await writeFile(`${extension}/manifest.json`, JSON.stringify(manifest));
const context = await chromium.launchPersistentContext(`${directory}/profile`, {
  executablePath: '/Users/shaobo.chen/Library/Caches/ms-playwright/chromium-1234/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing',
  headless: true, locale: 'en', viewport: { width: 420, height: 780 },
  args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`],
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
  await worker.evaluate(async tabId => {
    await chrome.scripting.executeScript({ target: { tabId }, files: ['content.js'] });
    await chrome.tabs.sendMessage(tabId, { type: 'deep-research:request-page' });
  }, tabId);
  await panel.locator('#page-view').waitFor({ state: 'visible' });
  const choose = async label => {
    await panel.locator('#translation-language-button').click();
    await panel.getByRole('menuitem', { name: label, exact: true }).click();
    await panel.waitForTimeout(100);
  };
  assert.equal(await panel.locator('#translation-language-button').innerText(), 'EN');
  await choose('简体中文');
  await panel.locator('#chat-translate').click();
  await panel.locator('#pause-translation').waitFor({ state: 'visible' });
  assert.equal(await panel.locator('#translation-language-button').isDisabled(), true);
  await panel.locator('#pause-translation').waitFor({ state: 'hidden', timeout: 20000 });
  assert.ok(requests.some(r => r.type === 'text' && r.language === 'zh-CN'));
  const textBatches = requests.filter(r => r.type === 'text' && r.language === 'zh-CN');
  assert.ok(textBatches[0].blocks.length <= 4, 'small leading batch paints early');
  assert.ok(textBatches.some(r => r.blocks.length === 24), 'later batches fill the backend block capacity');
  assert.ok(textBatches.every(r => r.blocks.length <= 24 && r.blocks.reduce((sum, block) => sum + block.text.length, 0) <= 3000));
  assert.equal(textBatches.reduce((sum, r) => sum + r.blocks.length, 0), 50, 'all source paragraphs sent exactly once');
  assert.equal(await article.locator('[data-deep-research-translation]').count(), 50);
  assert.ok(requests.some(r => r.type === 'image' && r.language === 'zh-CN'));
  await choose('English');
  await panel.locator('#chat-translate').click();
  await panel.locator('#pause-translation').waitFor({ state: 'visible' });
  await panel.locator('#pause-translation').waitFor({ state: 'hidden', timeout: 20000 });
  assert.ok(requests.some(r => r.type === 'text' && r.language === 'en'), 'new target does not skip previously translated blocks');
  const displayedLanguages = await article.locator('[data-deep-research-translation]').evaluateAll(nodes => nodes.map(n => n.dataset.deepResearchTargetLanguage));
  assert.ok(displayedLanguages.length > 0 && displayedLanguages.every(language => language === 'en'));
  await panel.evaluate(() => chrome.storage.local.set({ readerUiLanguage: 'zh-CN' }));
  await panel.reload(); await panel.waitForFunction(() => document.documentElement.dataset.readerReady === 'true');
  assert.equal(await panel.locator('#translation-language-button').innerText(), 'EN', 'explicit target survives reload and interface changes');
  await choose('日本語');
  await worker.evaluate(async ({ tabId, url }) => {
    await chrome.runtime.sendMessage({ type: 'deep-research:selection', tabId, context: { url, title: 'Worker architecture', body: 'A queue feeds two workers.', scope: 'selection', selection: { quote: 'A queue feeds two workers.' } } });
  }, { tabId, url: article.url() });
  await panel.locator('#chat-selection-card').waitFor({ state: 'visible' });
  await panel.locator('#chat-translate').click();
  await panel.locator('#conversation-list').filter({ hasText: '日本語の翻訳' }).waitFor({ timeout: 15000 });
  assert.ok(requests.some(r => r.type === 'answer' && r.prompt.includes('in ja')));
  await panel.locator('#clear-chat-selection').click();
  await panel.locator('#question-input').fill('Explain the queue in English.');
  await panel.locator('#send-question').click();
  await panel.locator('#conversation-list').filter({ hasText: 'An English answer.' }).waitFor({ timeout: 15000 });
  assert.ok(requests.filter(r => r.type === 'answer').at(-1).prompt.includes('language of the latest user question'));
  for (const width of [320, 420]) {
    await panel.setViewportSize({ width, height: 480 });
    const geometry = await panel.locator('#send-question').evaluate(el => el.getBoundingClientRect().toJSON());
    assert.ok(geometry.right <= width && geometry.bottom <= 480, 'footer fits narrow viewport');
  }
  await panel.screenshot({ path: `${directory}/target-language.png` });
  console.log(JSON.stringify({ pass: true, independentTarget: true, textAndImageTargets: true, selectionTarget: true, chatLanguageIndependent: true, persistence: true, oldTranslationsReplaced: true, directory }));
} finally { await context.close(); await new Promise(resolve => server.close(resolve)); }
