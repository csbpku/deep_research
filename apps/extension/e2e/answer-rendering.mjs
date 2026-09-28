import { createServer } from 'node:http';
import { cp, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { chromium } from '../../web/node_modules/@playwright/test/index.mjs';

const fixturePath = new URL('./fixture.html', import.meta.url);
const fixtureServer = createServer(async (_request, response) => {
  response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
  response.end(await readFile(fixturePath));
});
await new Promise((resolve, reject) => {
  fixtureServer.once('error', reject);
  fixtureServer.listen(0, '127.0.0.1', resolve);
});
const fixturePort = fixtureServer.address().port;

const providerServer = createServer(async (request, response) => {
  response.setHeader('access-control-allow-origin', '*');
  response.setHeader('access-control-allow-headers', 'content-type, authorization');
  response.setHeader('access-control-allow-methods', 'POST, OPTIONS');
  if (request.method === 'OPTIONS') {
    response.writeHead(204);
    response.end();
    return;
  }
  let raw = '';
  for await (const chunk of request) raw += chunk;
  const payload = raw ? JSON.parse(raw) : {};
  const system = payload.messages?.find((message) => message.role === 'system')?.content || '';
  const question = payload.messages?.at(-1)?.content || '';
  const answer = JSON.stringify({
    answer: '## 1. 核心结论\n\n有界队列限制并发工作量，取消操作可避免过期请求继续消耗模型容量。[1]\n\n## 2. 设计依据\n\n- 队列让浏览器工作保持响应。\n- 取消会停止过期请求。\n\n## 3. 适用边界\n\n- 这段原文没有给出队列的具体容量。\n\n## 4. 待核对原文证据\n\n- 具体容量需要结合实现配置确认。[1]',
    evidence: [{
      quote: 'Bounded queues keep browser work responsive because cancellation can stop stale requests before they consume more model capacity.',
      claim: 'c'.repeat(150),
    }],
    background: '',
    inference: '',
    limitations: ['当前原文没有说明队列容量。'],
  });
  const content = system.includes('视觉能力检查器')
    ? 'READER_VISION_CHECK'
    : question === 'Reply with OK only.' ? 'OK' : answer;
  response.writeHead(200, { 'content-type': 'application/json' });
  response.end(JSON.stringify({ choices: [{ message: { content } }] }));
});
await new Promise((resolve, reject) => {
  providerServer.once('error', reject);
  providerServer.listen(0, '127.0.0.1', resolve);
});

const extensionPath = new URL('../.output/chrome-mv3', import.meta.url).pathname;
const testRoot = await mkdtemp('/private/tmp/deep-research-reader-answer-');
const testExtensionPath = `${testRoot}/extension`;
await cp(extensionPath, testExtensionPath, { recursive: true });
const manifestPath = `${testExtensionPath}/manifest.json`;
const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
manifest.host_permissions = [...new Set([...(manifest.host_permissions || []), 'http://127.0.0.1/*'])];
await writeFile(manifestPath, JSON.stringify(manifest));

const executablePath = process.env.CHROME_FOR_TESTING
  || [
    '/Users/shaobo.chen/Library/Caches/ms-playwright/chromium-1234/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  ].find(existsSync);
if (!executablePath) throw new Error('找不到 Chrome，请设置 CHROME_FOR_TESTING');

const context = await chromium.launchPersistentContext(`/private/tmp/deep-research-reader-answer-${Date.now()}`, {
  executablePath,
  headless: process.env.READER_HEADLESS === '1',
  viewport: { width: 1280, height: 900 },
  args: [
    '--enable-extensions',
    `--disable-extensions-except=${testExtensionPath}`,
    `--load-extension=${testExtensionPath}`,
    '--no-first-run',
    '--no-default-browser-check',
  ],
});

try {
  const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
  const extensionId = new URL(worker.url()).host;
  const article = await context.newPage();
  await article.goto(`http://127.0.0.1:${fixturePort}/fixture.html`, { waitUntil: 'domcontentloaded' });
  await article.bringToFront();
  await worker.evaluate(async () => {
    const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    if (!tab?.id) throw new Error('article tab is not active');
    await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['content.js'] });
    await chrome.tabs.sendMessage(tab.id, { type: 'deep-research:request-page' });
  });

  const panel = await context.newPage();
  await panel.goto(`chrome-extension://${extensionId}/sidepanel.html`, { waitUntil: 'domcontentloaded' });
  await panel.waitForFunction(() => document.documentElement.dataset.readerReady === 'true', null, { timeout: 10_000 });
  await panel.locator('#settings-button').click();
  await panel.locator('#provider-kind').selectOption('custom');
  await panel.locator('#provider-url').fill(`http://127.0.0.1:${providerServer.address().port}/v1`);
  await panel.locator('#provider-model').fill('answer-rendering-fixture');
  await panel.locator('#provider-key').fill('local-only-test-key');
  await panel.locator('#save-settings').click();
  await panel.waitForFunction(() => document.querySelector('#settings-notice')?.textContent?.includes('模型连接成功'), null, { timeout: 10_000 });
  await panel.locator('#close-settings').click();

  await article.evaluate(() => {
    const node = document.querySelector('#target');
    if (!node) throw new Error('fixture paragraph is missing');
    const range = document.createRange();
    range.selectNodeContents(node);
    const selection = window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);
    node.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
  });
  await panel.locator('#selection-section').waitFor({ state: 'visible', timeout: 10_000 });
  await panel.locator('#ask-selection').click();
  await panel.locator('#question-input').fill('Why does cancellation matter?');
  await panel.locator('#send-question').click();
  await panel.locator('#reader-evidence-1').waitFor({ state: 'visible', timeout: 10_000 });
  await panel.waitForFunction(() => {
    const transcript = document.querySelector('#chat-transcript')?.getBoundingClientRect();
    const evidence = document.querySelector('#reader-evidence-1')?.getBoundingClientRect();
    return Boolean(transcript && evidence && evidence.top >= transcript.top && evidence.bottom <= transcript.bottom);
  }, null, { timeout: 5_000 });

  const rendered = await panel.evaluate(() => ({
    headings: [...document.querySelectorAll('#answer-output .reader-markdown-heading')].map((node) => node.textContent?.trim()),
    listItems: document.querySelectorAll('#answer-output li').length,
    citation: document.querySelector('#answer-output [data-reader-citation]')?.getAttribute('href') || '',
    evidenceText: document.querySelector('#reader-evidence-1')?.innerText || '',
    evidenceLink: document.querySelector('#reader-evidence-1')?.getAttribute('href') || '',
    evidenceLabel: document.querySelector('#answer-evidence .answer-label')?.textContent || '',
    claimTitle: document.querySelector('#reader-evidence-1 .evidence-claim')?.getAttribute('title') || '',
    transcript: (() => {
      const transcript = document.querySelector('#chat-transcript');
      const card = document.querySelector('#reader-evidence-1')?.getBoundingClientRect();
      const view = transcript?.getBoundingClientRect();
      return {
        scrollTop: transcript?.scrollTop,
        scrollHeight: transcript?.scrollHeight,
        clientHeight: transcript?.clientHeight,
        evidenceWithinView: Boolean(card && view && card.top >= view.top && card.bottom <= view.bottom),
      };
    })(),
  }));
  if (rendered.headings.length !== 4 || rendered.listItems < 3 || !rendered.citation.startsWith('http://127.0.0.1:')
    || !rendered.evidenceText.includes('定位原文') || !rendered.evidenceLink.startsWith('http://127.0.0.1:')
    || !rendered.evidenceLabel.includes('1') || rendered.claimTitle.length !== 150
    || !rendered.transcript.evidenceWithinView) {
    throw new Error(`answer formatting/citation acceptance failed: ${JSON.stringify(rendered)}`);
  }
  await article.bringToFront();
  await panel.evaluate(() => document.querySelector('#conversation-list [data-reader-citation="1"]')?.click());
  await panel.waitForFunction(() => document.querySelector('#notice')?.textContent?.includes('已回到原文证据'), null, { timeout: 5_000 });
  const sourceOutline = await article.locator('#target').evaluate((node) => getComputedStyle(node).outline);
  if (!sourceOutline.includes('rgb(49, 95, 232)')) throw new Error(`citation did not focus the original source: ${sourceOutline}`);
  await article.bringToFront();
  await worker.evaluate(async (url) => {
    const [tab] = await chrome.tabs.query({ url });
    if (tab?.id) await chrome.tabs.sendMessage(tab.id, { type: 'deep-research:request-page' });
  }, article.url());
  await panel.waitForFunction(() => document.querySelector('#page-context-status')?.textContent === '正文已读取', null, { timeout: 10_000 });
  await panel.screenshot({ path: '/private/tmp/deep-research-reader-answer-rendering.png', fullPage: true });
  console.log(JSON.stringify({ ok: true, extensionId, rendered, screenshot: '/private/tmp/deep-research-reader-answer-rendering.png' }, null, 2));
} finally {
  await context.close().catch(() => {});
  await new Promise((resolve) => providerServer.close(resolve));
  await new Promise((resolve) => fixtureServer.close(resolve));
}
