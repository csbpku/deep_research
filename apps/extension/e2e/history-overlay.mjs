import { cp, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { existsSync } from 'node:fs';
import { chromium } from '../../web/node_modules/@playwright/test/index.mjs';
import { tempPath } from './temp-paths.mjs';
import assert from 'node:assert/strict';

// Opening history used to replace the whole panel document, which threw away
// the composer draft and any in-flight answer. The overlay keeps the panel
// mounted; continuing a conversation refreshes its transcript and preserves
// whether this is a global sidepanel or a deliberately tab-bound panel.
const extensionPath = `${await mkdtemp(tempPath('reader-history-overlay-'))}/extension`;
await cp(new URL('../.output/chrome-mv3', import.meta.url), extensionPath, { recursive: true });
const manifestPath = `${extensionPath}/manifest.json`;
const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
manifest.host_permissions = [...new Set([...(manifest.host_permissions || []), 'http://127.0.0.1/*'])];
await writeFile(manifestPath, JSON.stringify(manifest));
const server = createServer((request, response) => {
  const title = request.url === '/b' ? 'Article B' : 'Article A';
  response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
  response.end(`<html><head><title>${title}</title></head><body><article><h1>${title}</h1><p>An article with enough source words for testing a reader history resume.</p></article></body></html>`);
});
await new Promise((resolve, reject) => {
  server.once('error', reject);
  server.listen(0, '127.0.0.1', resolve);
});
const origin = `http://127.0.0.1:${server.address().port}`;
const executablePath = process.env.CHROME_FOR_TESTING || [
  '/Users/shaobo.chen/Library/Caches/ms-playwright/chromium-1234/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
].find(existsSync);
if (!executablePath) throw new Error('找不到 Chrome，请设置 CHROME_FOR_TESTING');

const context = await chromium.launchPersistentContext(tempPath(`reader-history-overlay-profile-${Date.now()}`), {
  executablePath,
  headless: process.env.READER_HEADLESS === '1',
  viewport: { width: 400, height: 900 },
  args: [
    '--enable-extensions',
    `--disable-extensions-except=${extensionPath}`,
    `--load-extension=${extensionPath}`,
    '--no-first-run',
    '--no-default-browser-check',
  ],
});

try {
  const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
  const extensionId = new URL(worker.url()).host;
  await worker.evaluate(() => chrome.storage.local.set({ readerUiLanguage: 'zh-CN' }));

  const panel = await context.newPage();
  await panel.goto(`chrome-extension://${extensionId}/sidepanel.html`, { waitUntil: 'domcontentloaded' });
  await panel.waitForFunction(() => document.documentElement.dataset.readerReady === 'true');

  assert.equal(await panel.locator('#history-overlay').isVisible(), false, '历史浮层默认关闭');
  const before = panel.url();
  await panel.locator('#open-history-header').click();
  await panel.locator('#history-overlay').waitFor({ state: 'visible', timeout: 10_000 });
  assert.equal(panel.url(), before, '打开历史不应改变面板地址或重新加载');
  const source = await panel.locator('#history-frame').getAttribute('src');
  assert.match(source, /reading-history\.html\?surface=sidepanel&embedded=1/, '历史以内嵌模式加载');
  const backgroundInert = await panel.evaluate(() => [...document.querySelector('.shell').children]
    .filter(node => node.id !== 'history-overlay')
    .every(node => node.inert));
  assert.equal(backgroundInert, true, '浮层打开时背景控件不可聚焦');

  const frame = panel.frameLocator('#history-frame');
  await frame.locator('#history-search-input').waitFor({ state: 'visible', timeout: 10_000 });
  assert.equal(await frame.locator('.masthead').isVisible(), false, '内嵌历史不重复渲染导航头');
  assert.equal(await frame.locator('#history-tabs').isVisible(), true, '内嵌历史保留会话与结论分类');

  // The panel's own close button and Escape both dismiss the overlay without a
  // navigation, so an in-flight composer draft is never lost on a mis-click.
  await panel.keyboard.press('Escape');
  await panel.locator('#history-overlay').waitFor({ state: 'hidden', timeout: 10_000 });
  await panel.locator('#open-history-header').click();
  await panel.locator('#history-overlay').waitFor({ state: 'visible', timeout: 10_000 });
  await panel.locator('#close-history-overlay').click();
  await panel.locator('#history-overlay').waitFor({ state: 'hidden', timeout: 10_000 });
  const backgroundRestored = await panel.evaluate(() => [...document.querySelector('.shell').children]
    .filter(node => node.id !== 'history-overlay')
    .every(node => !node.inert));
  assert.equal(backgroundRestored, true, '关闭浮层后背景控件恢复可聚焦');

  // A separate tab remains available for readers who want history beside the
  // article instead of on top of the chat.
  const tabPromise = context.waitForEvent('page');
  await panel.locator('#open-history-header').click();
  await panel.locator('#history-overlay').waitFor({ state: 'visible', timeout: 10_000 });
  await panel.locator('#history-open-tab').click();
  const historyTab = await tabPromise;
  await historyTab.waitForLoadState('domcontentloaded');
  assert.match(historyTab.url(), /reading-history\.html\?surface=tab/, '“在标签页打开”使用独立页面');
  await historyTab.close();
  await panel.locator('#close-history-overlay').click();

  const saveTranscript = async (turns) => panel.evaluate(async ({ url, turns }) => {
    const database = await new Promise((resolve, reject) => {
      const request = indexedDB.open('deep-research-reader', 4);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    await new Promise((resolve, reject) => {
      const transaction = database.transaction('sessions', 'readwrite');
      transaction.objectStore('sessions').put({
        id: `${url}::v1`, url, title: 'Resume Article A', version: 'v1',
        updatedAt: `2026-11-11T00:0${turns}:00.000Z`,
        discussion: Array.from({ length: turns }, (_, index) => [
          { role: 'user', content: `Question ${index + 1}` },
          { role: 'assistant', content: `Answer ${index + 1}` },
        ]).flat(),
      });
      transaction.oncomplete = resolve;
      transaction.onerror = () => reject(transaction.error);
    });
    database.close();
  }, { url: `${origin}/a`, turns });

  await saveTranscript(1);
  await panel.locator('#open-history-header').click();
  await frame.getByText('2 条消息', { exact: false }).waitFor();
  await panel.locator('#close-history-overlay').click();
  await saveTranscript(2);
  await panel.locator('#open-history-header').click();
  await frame.getByText('4 条消息', { exact: false }).waitFor();
  // Another answer finishes while the visible row still carries Q1/Q2.
  await saveTranscript(3);
  const resumed = panel.waitForEvent('domcontentloaded');
  await frame.getByRole('button', { name: '继续聊天', exact: true }).first().click();
  await resumed;
  await panel.waitForFunction(() => document.documentElement.dataset.readerReady === 'true');
  assert.equal(new URL(panel.url()).searchParams.has('sourceTab'), false, '普通侧栏恢复会话后仍跟随活动标签页');
  await panel.waitForFunction(() => document.querySelector('#conversation-list')?.textContent.includes('Answer 3'));
  for (const turn of ['Question 1', 'Question 2', 'Question 3']) {
    assert.ok((await panel.locator('#conversation-list').innerText()).includes(turn), `恢复后保留 ${turn}`);
  }
  const sourceTab = await worker.evaluate(async url => {
    const tab = (await chrome.tabs.query({ url }))[0];
    if (!tab?.id) throw new Error('history did not open the source article');
    await chrome.storage.session.set({ [`readingWindow:${tab.windowId}`]: true });
    return tab.id;
  }, `${origin}/a`);
  const articleB = await context.newPage();
  await articleB.goto(`${origin}/b`, { waitUntil: 'domcontentloaded' });
  await articleB.bringToFront();
  await panel.waitForFunction(() => document.querySelector('#page-title')?.textContent === 'Article B');

  // Deliberately tab-bound panels must keep their original behavior.
  const bound = await context.newPage();
  await bound.goto(`chrome-extension://${extensionId}/sidepanel.html?sourceTab=${sourceTab}`);
  await bound.waitForFunction(() => document.documentElement.dataset.readerReady === 'true');
  await bound.locator('#open-history-header').click();
  const boundResumed = bound.waitForEvent('domcontentloaded');
  await bound.frameLocator('#history-frame').locator('.history-card').filter({ hasText: `${origin}/a` }).first().getByRole('button', { name: '继续聊天', exact: true }).click();
  await boundResumed;
  await bound.waitForFunction(() => document.documentElement.dataset.readerReady === 'true');
  assert.equal(new URL(bound.url()).searchParams.get('sourceTab'), String(sourceTab), '独立绑定窗口恢复后保留原标签页绑定');
  await bound.waitForFunction(() => document.querySelector('#page-title')?.textContent === 'Article A');
  await articleB.bringToFront();
  await panel.waitForFunction(() => document.querySelector('#page-title')?.textContent === 'Article B');
  assert.equal(await bound.locator('#page-title').innerText(), 'Article A', '绑定窗口不跟随其他活动标签页');

  console.log(JSON.stringify({
    ok: true,
    checks: [
      'opening history keeps the panel document and URL',
      'the embedded list hides the duplicate masthead but keeps both tabs',
      'Escape and the close button dismiss the overlay',
      'history can still open in its own tab',
      'reopening history refreshes completed answers',
      'continuing an already-open row restores the latest transcript',
      'the global panel still follows activated article tabs after resume',
      'an explicitly bound panel retains its source tab after resume',
    ],
  }, null, 2));
} finally {
  await context.close();
  await new Promise(resolve => server.close(resolve));
}
