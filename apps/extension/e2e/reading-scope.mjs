import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { cp, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { join } from 'node:path';
import { chromium } from '../../web/node_modules/@playwright/test/index.mjs';
import { tempDir } from './temp-paths.mjs';

// A VitePress-shaped docs page: a thin title <main>, then the real article in a
// second <main>. Reading only the first <main> captured two blocks here.
const paragraphs = Array.from({ length: 12 }, (_, index) => (
  `<p>Article paragraph ${index + 1} explains the workflow with enough detail to count as body text for the reader.</p>`
)).join('');
const page = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>AI Assistants</title></head><body>
  <aside class="sidebar"><a href="/a">Intro</a><a href="/b">Guides</a><a href="/c">API</a></aside>
  <main class="vp-doc"><h1>AI Assistants</h1><p>Practical ways to use AI assistants with the product.</p></main>
  <main class="main"><h2>Why it works</h2>${paragraphs}</main>
</body></html>`;

const server = createServer((request, response) => {
  if (request.url === '/vitepress') {
    response.setHeader('content-type', 'text/html; charset=utf-8');
    response.end(page);
    return;
  }
  response.writeHead(404);
  response.end();
});
await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
const origin = `http://127.0.0.1:${server.address().port}`;

const root = await mkdtemp(join(tempDir(), 'reader-reading-scope-'));
const extensionPath = join(root, 'extension');
await cp(new URL('../.output/chrome-mv3', import.meta.url), extensionPath, { recursive: true });
const manifestPath = join(extensionPath, 'manifest.json');
const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
manifest.host_permissions = [...new Set([...(manifest.host_permissions || []), 'http://127.0.0.1/*'])];
await writeFile(manifestPath, JSON.stringify(manifest));

const executablePath = process.env.CHROME_FOR_TESTING || [
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Users/shaobo.chen/Library/Caches/ms-playwright/chromium-1234/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing',
].find(existsSync);
assert.ok(executablePath, 'Set CHROME_FOR_TESTING to an installed Chrome binary');

const browser = await chromium.launchPersistentContext(join(root, 'profile'), {
  executablePath, headless: true, viewport: { width: 1280, height: 900 },
  args: ['--enable-extensions', `--disable-extensions-except=${extensionPath}`, `--load-extension=${extensionPath}`, '--no-first-run', '--no-default-browser-check'],
});

try {
  const worker = browser.serviceWorkers()[0] || await browser.waitForEvent('serviceworker');
  const article = await browser.newPage();
  await article.goto(`${origin}/vitepress`);
  await article.bringToFront();
  await worker.evaluate(async () => {
    const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['content.js'] });
  });
  // The page-request handler extracts blocks and tags each one with
  // data-deep-research-block, so the DOM shows exactly what the reader read.
  await worker.evaluate(async () => {
    const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    await chrome.tabs.sendMessage(tab.id, { type: 'deep-research:request-page' });
  });
  await article.waitForFunction(() => document.querySelectorAll('[data-deep-research-block]').length > 0, null, { timeout: 15_000 });

  const read = await article.evaluate(() => {
    const blocks = Array.from(document.querySelectorAll('[data-deep-research-block]'));
    const inMain = (selector) => blocks.filter((node) => node.closest(selector)).length;
    return {
      total: blocks.length,
      titleMain: inMain('main.vp-doc'),
      articleMain: inMain('main.main'),
      sidebar: inMain('aside'),
    };
  });
  // Title block (h1 + intro) plus the twelve article paragraphs and the section heading.
  assert.ok(read.articleMain >= 12, `article main read ${read.articleMain} blocks, expected the 12 paragraphs`);
  assert.ok(read.titleMain >= 1, 'title region should be read too');
  assert.equal(read.sidebar, 0, 'sidebar links must not be read');
  console.log(`reading-scope e2e passed: title ${read.titleMain}, article ${read.articleMain}, total ${read.total}`);
} finally {
  await browser.close();
  server.close();
}
