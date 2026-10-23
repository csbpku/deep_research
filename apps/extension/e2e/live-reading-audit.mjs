import assert from 'node:assert/strict';
import { cp, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { chromium } from '../../web/node_modules/@playwright/test/index.mjs';
import { join } from 'node:path';
import { tempDir, tempPath } from './temp-paths.mjs';

if (process.env.READER_LIVE !== '1' || !process.env.READER_LIVE_MODEL) throw new Error('Use READER_LIVE=1 and select READER_LIVE_MODEL explicitly.');
const artifacts = await mkdtemp(join(tempDir(), 'reader-live-reading-audit-'));
const extension = `${artifacts}/extension`;
await cp(new URL('../.output/chrome-mv3', import.meta.url).pathname, extension, { recursive: true });
const manifest = JSON.parse(await readFile(`${extension}/manifest.json`, 'utf8'));
manifest.host_permissions = ['http://127.0.0.1:8317/*', 'https://developer.mozilla.org/*'];
await writeFile(`${extension}/manifest.json`, JSON.stringify(manifest));
const context = await chromium.launchPersistentContext(`${artifacts}/profile`, {
  executablePath: process.env.CHROME_FOR_TESTING || '/Users/shaobo.chen/Library/Caches/ms-playwright/chromium-1234/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing',
  headless: true, viewport: { width: 1280, height: 850 },
  args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`],
});
const report = { artifacts, version: manifest.version, model: process.env.READER_LIVE_MODEL, source: 'https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Promise' };
let panel;
try {
  const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
  const id = new URL(worker.url()).host;
  const article = await context.newPage();
  await article.goto(report.source, { waitUntil: 'domcontentloaded' });
  const tabId = await worker.evaluate(async url => (await chrome.tabs.query({ url }))[0].id, report.source);
  panel = await context.newPage(); await panel.setViewportSize({ width: 380, height: 850 });
  await panel.goto(`chrome-extension://${id}/sidepanel.html?sourceTab=${tabId}`);
  await panel.waitForFunction(() => document.documentElement.dataset.readerReady === 'true');
  await article.bringToFront();
  await worker.evaluate(async tabId => {
    await chrome.scripting.executeScript({ target: { tabId }, files: ['content.js'] });
    await chrome.tabs.sendMessage(tabId, { type: 'deep-research:request-page' });
  }, tabId);
  await panel.locator('#page-view').waitFor({ state: 'visible' });
  await panel.locator('#settings-button').click();
  await panel.locator('#provider-kind').selectOption('local-proxy', { force: true });
  await panel.locator('#refresh-models').click();
  await panel.locator(`#provider-model-list option[value="${report.model}"]`).waitFor({ state: 'attached' });
  await panel.locator('#provider-model-list').selectOption(report.model);
  await panel.locator('#save-settings').click();
  await panel.locator('#settings-notice').filter({ hasText: '已保存' }).waitFor();
  await panel.locator('#close-settings').click();
  const paragraph = article.locator('main p').filter({ hasText: 'The Promise object represents' }).first();
  const quote = await paragraph.innerText();
  assert.ok(quote.length > 50);
  await paragraph.evaluate(el => {
    const range = document.createRange(); range.selectNodeContents(el);
    const s = getSelection(); s.removeAllRanges(); s.addRange(range);
    el.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
  });
  await panel.locator('#chat-selection-card').waitFor();
  await panel.locator('#toggle-chat-selection').click();
  assert.ok((await panel.locator('#chat-selection-quote').innerText()).includes('Promise'));
  await panel.locator('#question-input').fill('请用两句话解释所选原文里的 Promise，不要展开其他内容。');
  const started = Date.now();
  await panel.locator('#send-question').click();
  await panel.locator('#stop-answer').waitFor({ state: 'visible' });
  await panel.locator('#stop-answer').waitFor({ state: 'hidden', timeout: 90000 });
  const answer = await panel.locator('#conversation-list .assistant .conversation-message-body').last().innerText();
  assert.ok(answer.length > 10, answer);
  report.answerMs = Date.now() - started; report.answer = answer;
  await panel.screenshot({ path: `${artifacts}/mdn-answer.png` });
  const translationStarted = Date.now();
  await article.bringToFront();
  await article.keyboard.press('Alt+Shift+KeyT');
  const translation = article.locator('[data-deep-research-selection-translation] .text');
  await translation.waitFor({ timeout: 90000 });
  report.translationMs = Date.now() - translationStarted;
  report.translation = await translation.innerText();
  assert.match(report.translation, /[\u4e00-\u9fff]/);
  assert.equal(await paragraph.innerText(), quote);
  await translation.evaluate(el => {
    const range = document.createRange(); range.selectNodeContents(el);
    const s = getSelection(); s.removeAllRanges(); s.addRange(range);
    el.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, composed: true }));
  });
  assert.ok(await translation.isVisible());
  await article.screenshot({ path: `${artifacts}/mdn-translation.png` });
  await panel.locator('#chat-tools-menu > summary').click(); await panel.locator('#restore-page').click();
  await translation.waitFor({ state: 'detached' });
  assert.equal(await paragraph.innerText(), quote);
  await panel.locator('#open-history-header').click();
  await panel.locator('#history-tabs[aria-busy="false"]').waitFor();
  await panel.locator('.history-card').filter({ hasText: 'Promise' }).first().getByRole('button', { name: '查看对话', exact: true }).click();
  await panel.locator('#history-detail').filter({ hasText: answer.slice(0, 20) }).waitFor();
  report.historyVerified = true; report.originalPreserved = true; report.selectableTranslation = true; report.pass = true;
  await panel.screenshot({ path: `${artifacts}/mdn-history.png` });
  await writeFile(`${artifacts}/report.json`, JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
} catch (error) { if (panel) await panel.screenshot({ path: `${artifacts}/failure.png` }).catch(() => {}); console.error(JSON.stringify(report)); throw error; }
finally { await context.close(); }
