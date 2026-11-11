import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { cp, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { chromium } from '../../web/node_modules/@playwright/test/index.mjs';
import { tempDir } from './temp-paths.mjs';

const root = await mkdtemp(join(tempDir(), 'reader-model-requests-'));
const extension = join(root, 'extension');
await cp(new URL('../.output/chrome-mv3', import.meta.url), extension, { recursive: true });
const manifest = JSON.parse(await readFile(join(extension, 'manifest.json'), 'utf8'));
manifest.host_permissions = [...new Set([...(manifest.host_permissions || []), 'http://127.0.0.1/*'])];
await writeFile(join(extension, 'manifest.json'), JSON.stringify(manifest));

const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="320" height="160"><rect width="320" height="160" fill="white"/><text x="12" y="80">Bounded queue</text></svg>';
const src = `data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`;
const secondSrc = `data:image/svg+xml;base64,${Buffer.from(svg.replace('Bounded queue', 'Another queue')).toString('base64')}`;
const html = `<html><head><title>Model scheduling</title></head><body><article><h1>Bounded queues</h1><p>Bounded queues preserve capacity for interactive work.</p><img id="first" src="${src}" width="320" height="160" alt="first diagram"><img id="second" src="${secondSrc}" width="320" height="160" alt="second diagram"></article></body></html>`;
let releaseImage;
const pendingImage = new Promise(resolve => { releaseImage = resolve; });
let markSecondRequested;
const secondRequested = new Promise(resolve => { markSecondRequested = resolve; });
const requests = [];
let limited = false;
const server = createServer(async (request, response) => {
  response.setHeader('access-control-allow-origin', '*');
  response.setHeader('access-control-allow-headers', 'authorization,content-type');
  if (request.method === 'OPTIONS') { response.writeHead(204); response.end(); return; }
  if (request.method === 'GET' && request.url === '/v1/models') { response.setHeader('content-type', 'application/json'); response.end(JSON.stringify({ data: [{ id: 'grok-4.7' }, { id: 'generic-model' }] })); return; }
  if (request.method === 'GET') { response.setHeader('content-type', 'text/html'); response.end(html); return; }
  let raw = '';
  for await (const chunk of request) raw += chunk;
  const body = JSON.parse(raw);
  requests.push(body);
  const image = Array.isArray(body.messages.at(-1)?.content);
  const second = image && body.messages.at(-1).content[0].text.includes('second diagram');
  if (image && !limited) {
    limited = true;
    response.writeHead(429, { 'retry-after': '0.01', 'content-type': 'application/json' });
    response.end('{}'); return;
  }
  if (second) { markSecondRequested(); await pendingImage; }
  const answer = JSON.stringify(image
    ? { hasReadableText: true, regions: [], confidence: 0.5, fallbackTranslation: second ? '第二张图的译文' : '第一张图的译文' }
    : { answer: '## 交互优先\n\n有界队列为交互保留容量，长任务不占满所有位置。\n\n- 为问答保留一个位置。\n- 后台翻译按批次处理。', evidence: [{ quote: 'Bounded queues preserve capacity for interactive work.', claim: '原文说明容量的作用。' }], limitations: [] });
  response.setHeader('content-type', body.stream ? 'text/event-stream' : 'application/json');
  response.end(body.stream
    ? `data: ${JSON.stringify({ choices: [{ delta: { content: answer } }] })}\n\ndata: [DONE]\n\n`
    : JSON.stringify({ choices: [{ message: { content: answer }, finish_reason: 'stop' }] }));
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
const executablePath = process.env.CHROME_FOR_TESTING || [
  '/Users/shaobo.chen/Library/Caches/ms-playwright/chromium-1234/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
].find(existsSync);
let browser;
try {
  browser = await chromium.launchPersistentContext(join(root, 'profile'), {
    executablePath, headless: process.env.READER_HEADLESS === '1',
    args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`, '--no-first-run'],
  });
  const worker = browser.serviceWorkers()[0] || await browser.waitForEvent('serviceworker');
  const extensionId = new URL(worker.url()).host;
  const page = await browser.newPage();
  await page.goto(origin);
  const panel = await browser.newPage();
  await panel.goto(`chrome-extension://${extensionId}/sidepanel.html`);
  await panel.waitForFunction(() => document.documentElement.dataset.readerReady === 'true');
  await panel.evaluate(async baseUrl => {
    const db = await new Promise((resolve, reject) => { const open = indexedDB.open('deep-research-reader', 4); open.onsuccess = () => resolve(open.result); open.onerror = () => reject(open.error); });
    await new Promise((resolve, reject) => {
      const tx = db.transaction('settings', 'readwrite');
      tx.objectStore('settings').put({ id: 'provider', value: { providerKind: 'custom', baseUrl, model: 'grok-4.7', apiKey: 'mock-only', visionReady: true } });
      tx.oncomplete = resolve; tx.onerror = () => reject(tx.error);
    });
    db.close();
  }, `${origin}/v1`);
  await page.bringToFront();
  await panel.reload();
  await panel.waitForFunction(() => document.documentElement.dataset.readerReady === 'true');
  await panel.locator('#composer-model').waitFor({ state: 'visible' });
  await panel.locator('#composer-model').click();
  await panel.locator('#composer-reasoning-mode').selectOption('high');
  await panel.waitForFunction(async () => {
    const db = await new Promise(resolve => { const open = indexedDB.open('deep-research-reader', 4); open.onsuccess = () => resolve(open.result); });
    const mode = await new Promise(resolve => { const read = db.transaction('settings').objectStore('settings').get('answerReasoningMode'); read.onsuccess = () => resolve(read.result?.value); });
    db.close(); return mode === 'high';
  });
  const savedEffort = await panel.evaluate(async () => {
    const db = await new Promise(resolve => { const open = indexedDB.open('deep-research-reader', 4); open.onsuccess = () => resolve(open.result); });
    const result = await new Promise(resolve => { const read = db.transaction('settings').objectStore('settings').get('answerReasoningMode'); read.onsuccess = () => resolve(read.result?.value); });
    db.close(); return result;
  });
  assert.equal(savedEffort, 'high', `saved effort differs from UI ${await panel.locator('#composer-reasoning-mode').inputValue()}`);
  assert.match(await panel.locator('#composer-reasoning-label').innerText(), /高|High/u);
  await panel.keyboard.press('Escape');
  await panel.locator('#composer-model-menu').waitFor({ state: 'hidden' });


  await page.bringToFront();
  const tabId = await worker.evaluate(async url => {
    const [tab] = await chrome.tabs.query({ url: `${url}/*` });
    await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['content.js'] });
    await chrome.tabs.sendMessage(tab.id, { type: 'deep-research:request-page' });
    return tab.id;
  }, origin);
  await page.waitForFunction(() => [...document.querySelectorAll('article img')].every(image => image.hasAttribute('data-deep-research-image')));
  const images = await page.locator('article img').evaluateAll(images => images.map(image => {
    const canvas = document.createElement('canvas'); canvas.width = 320; canvas.height = 160;
    canvas.getContext('2d').drawImage(image, 0, 0);
    return { id: image.getAttribute('data-deep-research-image'), src: image.src, dataUrl: canvas.toDataURL('image/png'), width: 320, height: 160, alt: image.alt };
  }));
  const context = { url: `${origin}/`, title: 'Bounded queues', targetLanguage: 'zh-CN', full: true, blocks: [], images };
  const start = await panel.evaluate(input => chrome.runtime.sendMessage(input), { type: 'deep-research:translation-start', jobId: 'images', tabId, context });
  assert.equal(start.ok, true);
  const imageSelector = '[data-deep-research-image-fallback], [data-deep-research-image-side-translation]';
  await page.waitForFunction(selector => document.querySelectorAll(selector).length === 1, imageSelector);
  await Promise.race([secondRequested, new Promise((_, reject) => setTimeout(() => reject(new Error('second image did not start')), 10_000).unref())]);
  assert.equal(requests.filter(body => Array.isArray(body.messages.at(-1).content)).length, 3);
  assert.deepEqual(requests[0], requests[1]);
  assert.ok(requests.every(body => body.reasoning_effort === 'low'));

  // A user-selected high-effort answer must run while the second background
  // image is still waiting. The translation's policy stays independently low.
  await panel.locator('#question-input').fill('Why a bounded queue?');
  await panel.locator('#send-question').click();
  await panel.locator('#conversation-list .assistant .reader-markdown-heading').waitFor();
  assert.equal(requests.at(-1).reasoning_effort, 'high', JSON.stringify(requests.map(body => ({ model: body.model, effort: body.reasoning_effort, stream: body.stream, image: Array.isArray(body.messages.at(-1).content) }))));
  assert.equal(requests.at(-1).stream, true);
  assert.match(requests.at(-1).messages[0].content, /separate distinct ideas with blank lines/u);
  assert.equal(await panel.locator('#conversation-list .assistant .reader-markdown-list li').count(), 2);
  // Wait past the content-script's 400ms mutation refresh. An image fallback
  // that leaks into the article body changes the page hash, makes the panel
  // restore translations, and removes this marker shortly after it is painted.
  await page.waitForTimeout(1200);
  assert.equal(await page.locator(imageSelector).count(), 1, 'the first image translation must survive the page-context refresh');
  releaseImage();
  await page.waitForFunction(selector => document.querySelectorAll(selector).length === 2, imageSelector);
  await page.waitForTimeout(1200);
  assert.equal(await page.locator(imageSelector).count(), 2, 'both image translations must survive the page-context refresh');
  await panel.reload();
  await panel.waitForFunction(() => document.documentElement.dataset.readerReady === 'true');
  await panel.locator('#composer-model').waitFor({ state: 'visible' });
  await panel.locator('#composer-model').click();
  assert.equal(await panel.locator('#composer-reasoning-mode').inputValue(), 'high');
  await panel.locator('#composer-model-options').getByText('generic-model', { exact: true }).click();
  await panel.locator('#composer-model').click();
  assert.equal(await panel.locator('#composer-reasoning-mode').isDisabled(), true);
  assert.match(await panel.locator('#composer-reasoning-label').innerText(), /默认|Default/u);
  await panel.locator('#composer-model-options').getByText('grok-4.7', { exact: true }).click();
  await panel.locator('#composer-model').click();
  assert.equal(await panel.locator('#composer-reasoning-mode').inputValue(), 'high');
  for (const width of [320, 447, 800]) {
    await panel.setViewportSize({ width, height: 900 });
    await panel.screenshot({ path: join(root, `composer-${width}.png`) });
    const layout = await panel.evaluate(() => ({ width: innerWidth, scroll: document.documentElement.scrollWidth, menu: document.querySelector('#composer-model-menu').getBoundingClientRect().toJSON() }));
    assert.ok(layout.scroll <= layout.width + 1, JSON.stringify(layout));
    assert.ok(layout.menu.left >= 0 && layout.menu.right <= layout.width + 1 && layout.menu.top >= 0, JSON.stringify(layout));
  }
  await panel.setViewportSize({ width: 447, height: 900 });
  await panel.evaluate(() => chrome.storage.local.set({ readerColorScheme: 'dark' }));
  await panel.waitForFunction(() => document.documentElement.dataset.readerScheme === 'dark');
  await panel.locator('#composer-model-menu').waitFor({ state: 'visible' });
  assert.equal(await panel.locator('#persistent-composer').isVisible(), true);
  assert.equal(await panel.locator('#composer-reasoning-mode').inputValue(), 'high');
  await panel.screenshot({ path: join(root, 'composer-dark-447.png') });
  await panel.keyboard.press('Escape');
  await panel.screenshot({ path: join(root, 'answer-dark-447.png') });
  const typography = await panel.locator('#conversation-list .assistant .reader-markdown-paragraph').first().evaluate(node => ({ size: parseFloat(getComputedStyle(node).fontSize), leading: parseFloat(getComputedStyle(node).lineHeight) }));
  assert.ok(typography.leading >= typography.size * 1.6, JSON.stringify(typography));
  const result = { passed: true, requests: requests.length, imagesPaintedIncrementally: 2, rejectedImageRetries: 1, savedAnswerEffort: 'high', translationEffort: 'low', isolatedProfile: root };
  await writeFile(join(root, 'result.json'), JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result));
} finally {
  releaseImage();
  await browser?.close();
  await new Promise(resolve => server.close(resolve));
}
