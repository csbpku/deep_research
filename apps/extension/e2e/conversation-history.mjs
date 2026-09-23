import { createServer } from 'node:http';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { chromium } from '../../../apps/web/node_modules/@playwright/test/index.mjs';

const port = 8892;
const fixturePath = new URL('./fixture.html', import.meta.url);
const fakeProvider = new URL('./fake-openai.mjs', import.meta.url).pathname;
const fixtureServer = createServer(async (request, response) => {
  if (request.url === '/fixture.html') {
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    response.end(await readFile(fixturePath));
    return;
  }
  response.writeHead(404);
  response.end('not found');
});
await new Promise((resolve, reject) => {
  fixtureServer.once('error', reject);
  fixtureServer.listen(port, '127.0.0.1', resolve);
});

const provider = spawn(process.execPath, [fakeProvider], { stdio: ['ignore', 'pipe', 'pipe'] });
const executablePath = process.env.CHROME_FOR_TESTING
  || [
    '/Users/shaobo.chen/Library/Caches/ms-playwright/chromium-1234/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  ].find(existsSync);
if (!executablePath) throw new Error('找不到 Chrome，请设置 CHROME_FOR_TESTING');

const extensionPath = new URL('../.output/chrome-mv3', import.meta.url).pathname;
const profilePath = `/private/tmp/deep-research-reader-history-${Date.now()}`;
const context = await chromium.launchPersistentContext(profilePath, {
  executablePath,
  headless: process.env.READER_HEADLESS === '1',
  viewport: { width: 1280, height: 900 },
  args: [
    '--enable-extensions',
    `--disable-extensions-except=${extensionPath}`,
    `--load-extension=${extensionPath}`,
    '--no-first-run',
    '--no-default-browser-check',
  ],
});

try {
  const serviceWorker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
  const extensionId = new URL(serviceWorker.url()).host;
  const article = await context.newPage();
  await article.goto(`http://127.0.0.1:${port}/fixture.html`, { waitUntil: 'domcontentloaded' });
  await article.bringToFront();
  await serviceWorker.evaluate(async () => {
    const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    if (!tab?.id) throw new Error('fixture tab is not active');
    await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['content.js'] });
    await chrome.tabs.sendMessage(tab.id, { type: 'deep-research:request-page' });
  });

  const panel = await context.newPage();
  await panel.goto(`chrome-extension://${extensionId}/sidepanel.html`, { waitUntil: 'domcontentloaded' });
  await panel.locator('#settings-button').waitFor({ state: 'visible', timeout: 10_000 });
  await serviceWorker.evaluate(async () => {
    const [tab] = await chrome.tabs.query({ url: 'http://127.0.0.1:8892/*' });
    if (!tab?.id) throw new Error('fixture tab is not available after opening the panel');
    await chrome.tabs.sendMessage(tab.id, { type: 'deep-research:request-page' });
  });
  // The fixture appends one paragraph shortly after load. Wait for that
  // version to settle and request a fresh snapshot before creating any
  // evidence-bearing answers, otherwise the strict content hash correctly
  // rejects the answer as stale during the test.
  // MutationObserver debounce in content.js is 400ms, so allow the
  // dynamically appended paragraph and the follow-up snapshot to arrive.
  await article.waitForTimeout(1_200);
  await serviceWorker.evaluate(async () => {
    const [tab] = await chrome.tabs.query({ url: 'http://127.0.0.1:8892/*' });
    if (!tab?.id) throw new Error('fixture tab is not available after dynamic content settles');
    await chrome.tabs.sendMessage(tab.id, { type: 'deep-research:request-page' });
  });
  await panel.locator('#settings-button').click();
  await panel.locator('#provider-kind').selectOption('custom');
  await panel.locator('#provider-url').fill('http://127.0.0.1:8799/v1');
  await panel.locator('#provider-model').fill('fake-reader');
  await panel.locator('#provider-key').fill('test-key');
  await panel.locator('#request-provider-origin').uncheck();
  await panel.locator('#save-settings').click();
  await panel.waitForFunction(() => document.querySelector('#settings-notice')?.textContent?.includes('连接成功'), null, { timeout: 10_000 });
  await panel.locator('#close-settings').click();
  if (await panel.locator('#discussion-section').isVisible()) {
    throw new Error('页面初始状态不应展示空聊天窗口');
  }
  if (!(await panel.locator('#open-page-chat').isVisible())) {
    throw new Error('页面初始状态缺少“问整页”入口');
  }
  if (!(await panel.locator('#quick-summary').isVisible())) {
    throw new Error('页面初始状态缺少独立的“全文总结”入口');
  }

  const selectedQuote = await article.evaluate(() => {
    const node = document.querySelector('#target');
    if (!node) throw new Error('fixture target paragraph is missing');
    const range = document.createRange();
    range.selectNodeContents(node);
    const selection = window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);
    node.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
    return (node.textContent || '').trim();
  });
  await panel.locator('#selection-section').waitFor({ state: 'visible', timeout: 10_000 });
  if (await panel.locator('#discussion-section').isVisible()) {
    throw new Error('仅选中原文时不应自动展开空聊天窗口');
  }

  await panel.locator('#explain-selection').click();
  await panel.locator('#discussion-section').waitFor({ state: 'visible', timeout: 5_000 });
  await panel.locator('.conversation-message.assistant').waitFor({ state: 'visible', timeout: 10_000 });
  if (!(await panel.locator('#scope-selection').isVisible())) {
    throw new Error('选段讨论没有显示“当前选段”范围切换');
  }
  await panel.locator('#scope-page').click();
  if ((await panel.locator('#discussion-context').innerText()) !== '整页正文 · 提问') {
    throw new Error('范围切换到整页后上下文标签不正确');
  }
  await panel.locator('#scope-selection').click();
  if ((await panel.locator('#discussion-context').innerText()) !== '当前选段 · 提问') {
    throw new Error('范围切换回选段后上下文标签不正确');
  }
  await panel.locator('#ask-selection').click();
  await panel.locator('#question-input').fill('如果队列容量很小，会有什么取舍？');
  await panel.locator('#send-question').click();
  await panel.locator('.conversation-message.assistant').nth(1).waitFor({ state: 'visible', timeout: 10_000 });

  await serviceWorker.evaluate(async () => {
    await chrome.runtime.sendMessage({ type: 'deep-research:page-action', action: 'summary' });
  });
  try {
    await panel.locator('.conversation-message.assistant').nth(2).waitFor({ state: 'visible', timeout: 10_000 });
  } catch (error) {
    console.error(JSON.stringify(await panel.evaluate(() => ({
      notice: document.querySelector('#notice')?.textContent || '',
      context: document.querySelector('#discussion-context')?.textContent || '',
      answer: document.querySelector('#answer-output')?.textContent || '',
      messages: document.querySelector('#conversation-list')?.textContent || '',
    })), null, 2));
    throw error;
  }
  const contextLabel = await panel.locator('#discussion-context').innerText();
  if (contextLabel !== '整页正文 · 全文总结') throw new Error(`全文总结上下文标签不正确：${contextLabel}`);
  const evidenceNumber = await panel.locator('#answer-evidence .evidence-number').first().innerText();
  if (evidenceNumber !== '[1]') throw new Error(`原文证据编号不正确：${evidenceNumber}`);
  await article.bringToFront();
  await panel.locator('#answer-evidence .evidence-item').first().evaluate((node) => node.click());
  try {
    await article.waitForFunction(() => Boolean(document.querySelector('#target')?.style.outline), null, { timeout: 5_000 });
  } catch (error) {
    console.error(JSON.stringify({
      url: await article.url(),
      targetText: await article.locator('#target').textContent(),
      targetStyle: await article.locator('#target').getAttribute('style'),
      panelNotice: await panel.locator('#notice').textContent(),
      panelContext: await panel.locator('#discussion-context').textContent(),
    }, null, 2));
    throw error;
  }
  const history = panel;
  const pageCountBeforeHistory = context.pages().length;
  await history.locator('#open-history-header').click();
  await history.waitForURL(new RegExp(`chrome-extension://${extensionId}/reading-history\\.html\\?surface=sidepanel$`));
  if (context.pages().length !== pageCountBeforeHistory) {
    throw new Error('打开聊天记录不应创建新的浏览器标签页');
  }
  const summaryCard = history.locator('.history-card').filter({ hasText: '整页正文 · 全文总结' }).first();
  try {
    await summaryCard.waitFor({ state: 'visible', timeout: 10_000 });
  } catch (error) {
    console.error(JSON.stringify(await history.locator('.history-card').allTextContents(), null, 2));
    throw error;
  }
  await summaryCard.locator('.history-card-action', { hasText: '查看对话' }).click();
  await history.locator('#history-detail').waitFor({ state: 'visible', timeout: 5_000 });
  const detail = await history.evaluate(() => ({
    title: document.querySelector('#history-detail-title')?.textContent || '',
    source: document.querySelector('#history-detail-source')?.textContent || '',
    selection: document.querySelector('#history-detail-selection')?.textContent || '',
    scope: document.querySelector('#history-detail-scope')?.textContent || '',
    messages: document.querySelectorAll('.history-detail-message').length,
    userMessages: document.querySelectorAll('.history-detail-message.user').length,
    assistantMessages: document.querySelectorAll('.history-detail-message.assistant').length,
    structured: !document.querySelector('#history-detail-structured')?.classList.contains('hidden'),
    listHidden: document.querySelector('#history-list')?.classList.contains('hidden'),
    continueVisible: !document.querySelector('#continue-history-detail')?.classList.contains('hidden'),
  }));
  if (!detail.selection.includes(selectedQuote)) throw new Error(`历史详情没有恢复原文选段：${JSON.stringify(detail)}`);
  if (detail.messages !== 6 || detail.userMessages !== 3 || detail.assistantMessages !== 3) {
    throw new Error(`历史详情消息不完整：${JSON.stringify(detail)}`);
  }
  if (!detail.structured) throw new Error(`历史详情没有恢复结构化证据：${JSON.stringify(detail)}`);
  if (!detail.listHidden || !detail.continueVisible) throw new Error(`历史详情没有替换列表或缺少继续入口：${JSON.stringify(detail)}`);

  await article.bringToFront();
  await history.locator('#continue-history-detail').evaluate((node) => node.click());
  await history.waitForURL(`chrome-extension://${extensionId}/sidepanel.html`);
  await history.locator('#discussion-section').waitFor({ state: 'visible', timeout: 10_000 });

  console.log(JSON.stringify({ ok: true, contextLabel, detail, continuedInSidePanel: true }, null, 2));
} finally {
  await context.close();
  provider.kill('SIGTERM');
  await new Promise((resolve) => fixtureServer.close(resolve));
}
