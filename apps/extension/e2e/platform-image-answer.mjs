import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { cp, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { chromium } from '../../web/node_modules/@playwright/test/index.mjs';

const directory = await mkdtemp('/private/tmp/reader-platform-vision-');
const requests = [];
const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="400" height="180"><rect width="400" height="180" fill="white"/><text x="40" y="85" font-size="30">Queue → Workers</text></svg>';
const server = createServer(async (req, res) => {
  res.setHeader('access-control-allow-origin', '*');
  if (req.url === '/diagram.svg') { res.setHeader('content-type', 'image/svg+xml'); res.end(svg); return; }
  if (req.url === '/article') { res.setHeader('content-type', 'text/html'); res.end('<article><h1>Worker architecture</h1><p>A queue feeds two workers.</p><img src="/diagram.svg" alt="Queue to workers diagram"></article>'); return; }
  let raw = ''; for await (const chunk of req) raw += chunk;
  if (req.url === '/api/reading/answer-image') {
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
  await worker.evaluate(({ tabId, src }) => chrome.tabs.sendMessage(tabId, { type: 'deep-research:select-image', src }), { tabId, src: `${origin}/diagram.svg` });
  await panel.locator('#image-section').waitFor({ state: 'visible' });
  await panel.locator('#scope-page').click();
  await panel.locator('#scope-image').click();
  await panel.locator('#scope-image').focus();
  assert.equal(await panel.locator('#discussion-scope-options button[aria-pressed="true"]').count(), 1, 'only one source scope remains selected after focus');
  assert.equal(await panel.locator('#scope-image').getAttribute('aria-pressed'), 'true');
  assert.ok(await panel.locator('#image-preview-thumbnail').isVisible(), 'selected image has a visible preview');
  await panel.locator('#explain-image').click();
  await panel.locator('#stop-answer').waitFor({ state: 'visible' });
  await panel.locator('#stop-answer').waitFor({ state: 'hidden', timeout: 15000 });
  assert.match(await panel.locator('#conversation-list').innerText(), /Turn 1/);
  await panel.locator('#question-input').fill('What feeds the workers?'); await panel.locator('#send-question').click();
  await panel.locator('#stop-answer').waitFor({ state: 'hidden', timeout: 15000 });
  await panel.locator('#conversation-list').filter({ hasText: 'Turn 2' }).waitFor();
  assert.equal(requests.length, 2);
  assert.ok(/^data:image\/(png|jpeg);base64,/u.test(requests[0].imageDataUrl), 'SVG is rasterized before worker/API handoff');
  assert.ok(requests[0].prompt.includes('Write all user-facing JSON fields in en'), 'generic explanation respects the English UI language');
  assert.ok(!Object.hasOwn(requests[0], 'imageUrl') && !Object.hasOwn(requests[0], 'src'));
  assert.ok(requests[1].history.some(turn => turn.content.includes('Turn 1')));
  await panel.setViewportSize({ width: 320, height: 480 });
  await panel.locator('#composer-size-toggle').click();
  const composerGeometry = await panel.locator('#send-question').evaluate(el => el.getBoundingClientRect().toJSON());
  assert.ok(composerGeometry.bottom <= 480, 'image context plus expanded input keeps Send inside a short viewport');
  await panel.setViewportSize({ width: 420, height: 780 });
  const messages = await panel.locator('#conversation-list > article').count();
  await panel.locator('#clear-image').click();
  assert.equal(await panel.locator('#conversation-list > article').count(), messages, 'clearing the image preserves chat');
  const snapshots = await worker.evaluate(() => chrome.storage.session.get(null));
  assert.ok(!JSON.stringify(snapshots).includes('data:image/'), 'answer snapshots never persist image bytes');
  console.log(JSON.stringify({ pass: true, requests: requests.length, svgRasterized: true, followupContext: true, chatPreserved: true, noImageBytesInSnapshots: true, directory }));
} finally { await context.close(); await new Promise(resolve => server.close(resolve)); }
