import { cp, mkdtemp } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { chromium } from '../../web/node_modules/@playwright/test/index.mjs';
import { tempPath } from './temp-paths.mjs';
import assert from 'node:assert/strict';

// Opening history used to replace the whole panel document, which threw away
// the composer draft and any in-flight answer. The overlay keeps the panel
// mounted; only "continue this conversation" is allowed to rebind the panel to
// the original article tab.
const extensionPath = `${await mkdtemp(tempPath('reader-history-overlay-'))}/extension`;
await cp(new URL('../.output/chrome-mv3', import.meta.url), extensionPath, { recursive: true });
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

  console.log(JSON.stringify({
    ok: true,
    checks: [
      'opening history keeps the panel document and URL',
      'the embedded list hides the duplicate masthead but keeps both tabs',
      'Escape and the close button dismiss the overlay',
      'history can still open in its own tab',
    ],
  }, null, 2));
} finally {
  await context.close();
}
