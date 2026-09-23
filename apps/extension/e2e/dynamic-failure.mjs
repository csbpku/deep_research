import { createServer } from 'node:http';
import { existsSync } from 'node:fs';
import { chromium } from '../../web/node_modules/@playwright/test/index.mjs';

const extensionPath = new URL('../.output/chrome-mv3', import.meta.url).pathname;
const pagePort = 8782;
const providerPort = 8806;
let failuresRemaining = 2;

const pageHtml = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Dynamic failure recovery</title><style>body{max-width:860px;margin:32px auto;font:17px/1.6 system-ui,sans-serif}</style></head><body><main><article><h1>Dynamic failure recovery</h1><p id="fail-block">FAIL_DYNAMIC_ONCE This paragraph must remain visible as a retryable failure when the page changes.</p><p id="stable-block">The stable paragraph should translate and remain available while the failing item is retried.</p><pre><code>const next = await queue.take();</code></pre></article></main><iframe title="cross-origin fixture" src="http://127.0.0.1:8783/embedded"></iframe><script>setTimeout(()=>{const p=document.createElement('p');p.id='dynamic-block';p.textContent='Dynamic content arrived after the first translation snapshot and must enter the queue.';document.querySelector('article').append(p)},900)</script></body></html>`;

const pageServer = createServer((_request, response) => {
  response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
  response.end(pageHtml);
});
await new Promise((resolve, reject) => {
  pageServer.once('error', reject);
  pageServer.listen(pagePort, '127.0.0.1', resolve);
});

function json(response, status, body) {
  response.writeHead(status, {
    'content-type': 'application/json',
    'access-control-allow-origin': '*',
    'cache-control': 'no-cache',
  });
  response.end(JSON.stringify(body));
}

const providerServer = createServer(async (request, response) => {
  if (request.method === 'OPTIONS') {
    response.writeHead(204, {
      'access-control-allow-origin': '*',
      'access-control-allow-headers': 'content-type, authorization',
      'access-control-allow-methods': 'POST, OPTIONS',
    });
    response.end();
    return;
  }
  let raw = '';
  for await (const chunk of request) raw += chunk;
  const payload = raw ? JSON.parse(raw) : {};
  const system = String(payload.messages?.find((item) => item.role === 'system')?.content || '');
  const user = payload.messages?.at(-1);
  const content = Array.isArray(user?.content)
    ? user.content.map((part) => part.text || '').join('\n')
    : String(user?.content || '');

  if (system.includes('视觉能力检查器')) {
    json(response, 200, { choices: [{ message: { content: 'READER_VISION_CHECK' } }] });
    return;
  }
  if (system.includes('技术文档翻译器') && content.includes('FAIL_DYNAMIC_ONCE') && failuresRemaining > 0) {
    failuresRemaining -= 1;
    json(response, 503, { error: { message: 'temporary dynamic test rate limit' } });
    return;
  }

  const answer = system.includes('技术文档翻译器')
    ? `译文：${content.replace(/^页面标题：[\s\S]*?原文：\n/u, '').slice(0, 120)}`
    : 'OK';
  await new Promise((resolve) => setTimeout(resolve, 120));
  if (payload.stream) {
    response.writeHead(200, {
      'content-type': 'text/event-stream',
      'access-control-allow-origin': '*',
      'cache-control': 'no-cache',
    });
    response.end(`data: ${JSON.stringify({ choices: [{ delta: { content: answer } }] })}\n\ndata: [DONE]\n\n`);
    return;
  }
  json(response, 200, { choices: [{ message: { content: answer } }] });
});
await new Promise((resolve, reject) => {
  providerServer.once('error', reject);
  providerServer.listen(providerPort, '127.0.0.1', resolve);
});

const executablePath = process.env.CHROME_FOR_TESTING
  || [
    '/Users/shaobo.chen/Library/Caches/ms-playwright/chromium-1234/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  ].find(existsSync);
if (!executablePath) throw new Error('找不到 Chrome，请设置 CHROME_FOR_TESTING');

const context = await chromium.launchPersistentContext(`/private/tmp/deep-research-reader-dynamic-failure-${Date.now()}`, {
  executablePath,
  headless: process.env.READER_HEADLESS === '1',
  viewport: { width: 1280, height: 900 },
  args: ['--enable-extensions', `--disable-extensions-except=${extensionPath}`, `--load-extension=${extensionPath}`, '--no-first-run', '--no-default-browser-check'],
});

try {
  const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
  const extensionId = new URL(worker.url()).host;
  const page = await context.newPage();
  await page.goto(`http://127.0.0.1:${pagePort}/`, { waitUntil: 'domcontentloaded' });
  const panel = await context.newPage();
  await panel.goto(`chrome-extension://${extensionId}/sidepanel.html`, { waitUntil: 'domcontentloaded' });
  await page.bringToFront();
  const tabId = await worker.evaluate(async () => {
    const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    if (!tab?.id) throw new Error('动态失败页面未激活');
    await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['content.js'] });
    await chrome.tabs.sendMessage(tab.id, { type: 'deep-research:request-page' });
    return tab.id;
  });
  await panel.locator('#page-view').waitFor({ state: 'visible', timeout: 10_000 });
  await panel.locator('#scope-notice').waitFor({ state: 'visible', timeout: 10_000 });
  if (!(await panel.locator('#scope-notice').innerText()).includes('跨域 iframe')) throw new Error('跨域 iframe 范围限制没有显示');
  await panel.locator('#settings-button').click();
  await panel.locator('#provider-kind').selectOption('custom');
  await panel.locator('#provider-url').fill(`http://127.0.0.1:${providerPort}/v1`);
  await panel.locator('#provider-model').fill('dynamic-reader');
  await panel.locator('#provider-key').fill('dynamic-test-key');
  await panel.locator('#request-provider-origin').uncheck();
  await panel.locator('#save-settings').click();
  await panel.locator('#settings-notice').waitFor({ state: 'visible', timeout: 10_000 });
  await panel.locator('#close-settings').click();
  await panel.locator('#translate-all').click();

  // Wait for the dynamically appended block to be translated. Its arrival
  // forces a new page snapshot while the old job already contains a failure.
  await page.waitForSelector('#dynamic-block', { state: 'attached', timeout: 10_000 });
  await page.waitForFunction(() => Boolean(document.querySelector('#dynamic-block')?.nextElementSibling?.hasAttribute('data-deep-research-translation')), null, { timeout: 30_000 });
  await panel.waitForFunction(() => document.querySelector('#translation-failures')?.textContent?.includes('需要处理'), null, { timeout: 30_000 });
  const failureText = await panel.locator('#translation-failures').innerText();
  if (!failureText.includes('FAIL_DYNAMIC_ONCE')) throw new Error(`动态更新后旧失败项没有保留：${failureText}`);

  await panel.locator('.translation-retry').first().click();
  await panel.waitForFunction(() => !document.querySelector('#translation-failures')?.textContent?.includes('需要处理'), null, { timeout: 30_000 });
  const final = await page.evaluate(() => ({
    dynamicTranslated: Boolean(document.querySelector('#dynamic-block')?.nextElementSibling?.hasAttribute('data-deep-research-translation')),
    failureRows: document.querySelectorAll('[data-deep-research-translation]').length,
  }));
  if (!final.dynamicTranslated) throw new Error(`动态正文翻译结果丢失：${JSON.stringify(final)}`);
  console.log(JSON.stringify({ extensionId, tabId, failuresRemaining, preservedFailure: true, retried: true, final }, null, 2));
} finally {
  await context.close().catch(() => {});
  await new Promise((resolve) => providerServer.close(resolve));
  await new Promise((resolve) => pageServer.close(resolve));
}
