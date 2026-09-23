import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { chromium } from '../../web/node_modules/@playwright/test/index.mjs';

const pageKinds = [
  ...Array.from({ length: 6 }, (_, index) => ({ kind: 'article', host: 'reader.local', path: `/article-${index + 1}`, imageCount: 2 })),
  ...Array.from({ length: 6 }, (_, index) => ({ kind: 'docs', host: 'docs.local', path: `/docs-${index + 1}`, imageCount: 1 })),
  ...Array.from({ length: 6 }, (_, index) => ({ kind: 'github', host: 'github.localhost', path: `/example/repo-${index + 1}`, imageCount: 1 })),
  ...Array.from({ length: 6 }, (_, index) => ({ kind: 'zread', host: 'zread.localhost', path: `/example/repo-${index + 1}`, imageCount: 1 })),
];

function diagram(kind, index) {
  return `<svg class="diagram" viewBox="0 0 720 180" width="720" height="180" role="img" aria-label="${kind} architecture ${index}">
    <rect x="12" y="20" width="190" height="64" fill="#e8eefc" stroke="#315fe8"/><text x="30" y="58" font-size="22">Producer</text>
    <rect x="262" y="20" width="190" height="64" fill="#fff3d6" stroke="#c68722"/><text x="280" y="58" font-size="22">Bounded Queue</text>
    <rect x="512" y="20" width="190" height="64" fill="#e6f7ef" stroke="#24915b"/><text x="530" y="58" font-size="22">Worker</text>
    <text x="170" y="140" font-size="18">${kind.toUpperCase()}_${index}_CAPACITY</text>
  </svg>`;
}

function renderPage(meta) {
  const content = `<h1>${meta.kind} page ${meta.path}</h1>
    <p id="intro">This technical page explains a bounded queue and a cancellable worker pipeline for developers.</p>
    <h2>Mechanism</h2>
    <p id="evidence-target">Bounded queues keep browser work responsive because cancellation can stop stale requests before they consume more model capacity.</p>
    <p>The queue preserves source structure, makes cancellation observable, and keeps evidence tied to the original paragraph.</p>
    <p>Dynamic content should enter the reading context after the first render without replacing the current document.</p>
    <a id="source-link" href="https://example.com/source/${meta.kind}/${meta.path.slice(1)}">source link</a>
    <pre><code>const result = await worker.run({ signal });</code></pre>
    ${Array.from({ length: meta.imageCount }, (_, index) => `<figure>${diagram(meta.kind, index + 1)}<figcaption>Architecture diagram ${index + 1}</figcaption></figure>`).join('')}`;
  const wrapper = meta.kind === 'github'
    ? `<main><div id="readme" class="markdown-body">${content}</div></main>`
    : meta.kind === 'zread'
      ? `<main><article>${content}</article></main>`
      : meta.kind === 'docs'
        ? `<main><article>${content}</article></main>`
        : `<main><article>${content}</article></main>`;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${meta.kind} ${meta.path}</title><style>body{max-width:920px;margin:32px auto;font:17px/1.6 system-ui,sans-serif}svg{max-width:100%;height:auto}pre{padding:12px;background:#f2f3f5}</style></head><body>${wrapper}<script>setTimeout(()=>{const p=document.createElement('p');p.id='dynamic';p.textContent='Dynamic content arrived after the first render.';document.querySelector('article,.markdown-body').append(p)},220)</script></body></html>`;
}

const server = createServer((request, response) => {
  const meta = pageKinds.find((item) => item.host === request.headers.host?.split(':')[0] && item.path === new URL(request.url || '/', 'http://local').pathname);
  if (!meta) {
    response.writeHead(404);
    response.end('not found');
    return;
  }
  response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
  response.end(renderPage(meta));
});
await new Promise((resolve, reject) => { server.once('error', reject); server.listen(8767, '127.0.0.1', resolve); });
const provider = spawn(process.execPath, [new URL('./fake-openai.mjs', import.meta.url).pathname], { env: { ...process.env, PORT: '8801' }, stdio: ['ignore', 'pipe', 'pipe'] });
await new Promise((resolve) => setTimeout(resolve, 300));

const extensionPath = new URL('../.output/chrome-mv3', import.meta.url).pathname;
const executablePath = process.env.CHROME_FOR_TESTING
  || [
    '/Users/shaobo.chen/Library/Caches/ms-playwright/chromium-1234/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  ].find(existsSync);
if (!executablePath) throw new Error('找不到 Chrome，请设置 CHROME_FOR_TESTING');
const context = await chromium.launchPersistentContext(`/private/tmp/deep-research-reader-matrix-${Date.now()}`, {
  executablePath,
  headless: process.env.READER_HEADLESS === '1',
  viewport: { width: 1280, height: 900 },
  args: [
    '--enable-extensions',
    `--disable-extensions-except=${extensionPath}`,
    `--load-extension=${extensionPath}`,
    '--host-resolver-rules=MAP reader.local 127.0.0.1,MAP docs.local 127.0.0.1',
    '--no-first-run',
    '--no-default-browser-check',
  ],
});

try {
  const serviceWorker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
  const extensionId = new URL(serviceWorker.url()).host;
  const page = await context.newPage();
  const panel = await context.newPage();
  await panel.goto(`chrome-extension://${extensionId}/sidepanel.html`, { waitUntil: 'domcontentloaded' });
  await panel.locator('#settings-button').click();
  await panel.locator('#provider-kind').selectOption('custom');
  await panel.locator('#provider-url').fill('http://127.0.0.1:8801/v1');
  await panel.locator('#provider-model').fill('fake-reader');
  await panel.locator('#provider-key').fill('test-key');
  await panel.locator('#request-provider-origin').uncheck();
  await panel.locator('#save-settings').click();
  await panel.locator('#settings-notice').waitFor({ state: 'visible', timeout: 10_000 });
  await panel.locator('#close-settings').click();

  const results = [];
  for (const meta of pageKinds) {
    const url = `http://${meta.host}:8767${meta.path}`;
    await page.goto(url, { waitUntil: 'domcontentloaded' });
    await page.bringToFront();
    await serviceWorker.evaluate(async () => {
      const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
      if (!tab?.id) throw new Error('matrix page is not active');
      await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['content.js'] });
      await chrome.tabs.sendMessage(tab.id, { type: 'deep-research:request-page' });
    });
    await panel.locator('#page-view').waitFor({ state: 'visible', timeout: 10_000 });
    await panel.locator('#translate-all').click();
    try {
      await panel.locator('#notice').filter({ hasText: '全文翻译完成' }).waitFor({ state: 'visible', timeout: 30_000 });
    } catch (error) {
      const debug = {
        url,
        panelText: (await panel.locator('body').innerText()).slice(-1_500),
        progress: await panel.locator('#progress-area').innerText().catch(() => ''),
        notice: await panel.locator('#notice').innerText().catch(() => ''),
        pageTitle: await page.title(),
        pageBody: (await page.locator('body').innerText()).slice(0, 300),
      };
      throw new Error(`matrix translation timeout: ${JSON.stringify(debug)}; ${error.message}`);
    }
    await page.bringToFront();
    await page.waitForSelector('#dynamic', { state: 'attached', timeout: 5_000 });
    // A page can append a paragraph after the first full-document snapshot.
    // Full translation must keep the reading session live and enqueue that
    // new block; merely observing the node is not enough evidence.
    try {
      await page.waitForFunction(() => {
        const dynamic = document.querySelector('#dynamic');
        return Boolean(dynamic?.nextElementSibling?.hasAttribute('data-deep-research-translation'));
      }, null, { timeout: 10_000 });
    } catch (error) {
      const debug = await page.evaluate(() => ({
        dynamic: Boolean(document.querySelector('#dynamic')),
        dynamicId: document.querySelector('#dynamic')?.getAttribute('data-deep-research-block') || null,
        dynamicNext: document.querySelector('#dynamic')?.nextElementSibling?.outerHTML?.slice(0, 180) || null,
      }));
      const panelDebug = await panel.locator('body').innerText().catch(() => '');
      throw new Error(`dynamic translation timeout: ${JSON.stringify({ debug, panel: panelDebug.slice(-1200) })}; ${error.message}`);
    }
    // The incremental job translates text before images. Waiting only for the
    // newly appended paragraph would sample the page between those two
    // phases and report a false image failure.
    await page.waitForFunction((expected) => document.querySelectorAll('[data-deep-research-image-overlay]').length === expected, meta.imageCount, { timeout: 30_000 });
    const result = await page.evaluate(() => ({
      textTranslations: document.querySelectorAll('[data-deep-research-translation]').length,
      imageOverlays: document.querySelectorAll('[data-deep-research-image-overlay]').length,
      sourceLink: document.querySelector('#source-link')?.getAttribute('href'),
      code: document.querySelector('pre code')?.textContent,
      dynamic: Boolean(document.querySelector('#dynamic')),
      dynamicTranslated: Boolean(document.querySelector('#dynamic')?.nextElementSibling?.hasAttribute('data-deep-research-translation')),
    }));
    if (!result.textTranslations || result.imageOverlays !== meta.imageCount || !result.sourceLink || !result.code || !result.dynamic || !result.dynamicTranslated) {
      throw new Error(`matrix failure for ${meta.kind}${meta.path}: ${JSON.stringify(result)}`);
    }
    await page.evaluate(() => {
      const target = document.querySelector('#evidence-target');
      const range = document.createRange();
      range.selectNodeContents(target);
      const selection = window.getSelection();
      selection.removeAllRanges();
      selection.addRange(range);
      document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
    });
    await panel.locator('#selection-section').waitFor({ state: 'visible', timeout: 10_000 });
    await panel.locator('#explain-selection').click();
    await panel.locator('#answer-evidence .evidence-item').waitFor({ state: 'visible', timeout: 20_000 });
    await panel.locator('#answer-evidence .evidence-item').first().click();
    await page.waitForFunction(() => Boolean(document.querySelector('#evidence-target')?.style.outline), null, { timeout: 5_000 });
    results.push({ ...meta, ...result, anchorResolved: true });
    await panel.locator('#restore-page').click();
    await page.waitForFunction(() => document.querySelectorAll('[data-deep-research-translation],[data-deep-research-image-overlay]').length === 0, null, { timeout: 10_000 });
  }
  const imageCount = results.reduce((sum, item) => sum + item.imageCount, 0);
  console.log(JSON.stringify({ pages: results.length, imageCount, kinds: Object.fromEntries(['article', 'docs', 'github', 'zread'].map((kind) => [kind, results.filter((item) => item.kind === kind).length])) }, null, 2));
} finally {
  await context.close();
  provider.kill('SIGTERM');
  await new Promise((resolve) => provider.once('exit', resolve));
  await new Promise((resolve) => server.close(resolve));
}
