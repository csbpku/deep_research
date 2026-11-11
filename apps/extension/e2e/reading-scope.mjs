import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { cp, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { join } from 'node:path';
import { chromium, expect } from '../../web/node_modules/@playwright/test/index.mjs';
import { tempDir } from './temp-paths.mjs';

// A VitePress-shaped docs page: a thin title <main>, then the real article in a
// second <main>. Reading only the first <main> captured two blocks here.
const paragraphs = Array.from({ length: 12 }, (_, index) => (
  `<p>Article paragraph ${index + 1} explains the workflow with enough detail to count as body text for the reader.</p>`
)).join('');
const html = (body) => `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Reading scope</title></head><body>${body}</body></html>`;
const leafText = `A unique article opening. ${'Valid article body paragraph. '.repeat(40)}`.trim();
const pages = new Map([
  ['/vitepress', html(`
  <aside class="sidebar"><a href="/a">Intro</a><a href="/b">Guides</a><a href="/c">API</a></aside>
  <main class="vp-doc"><h1>AI Assistants</h1><p>Practical ways to use AI assistants with the product.</p></main>
  <main class="main"><h2>Why it works</h2>${paragraphs}</main>
  `)],
  ['/translation', html(`<main id="primary"><h1>Guide</h1><p>${'Primary source material. '.repeat(50)}</p></main><main id="secondary"><h2>Additional details</h2><p>${'Secondary source. '.repeat(13)}</p></main>`)],
  ['/partial', html(`<article id="short"><h1>Short article</h1><p>${'Short genuine source. '.repeat(30)}</p></article><div><p>${'Other genuine source. '.repeat(150)}</p></div>`)],
  ['/late', html('<main id="title"><h1>Late loading title</h1><p>Introductory prose that belongs to this article.</p></main><div id="app"></div>')],
  ['/site-specific', html('<main><p id="metadata">Repository metadata outside the README.</p><article id="readme"><p>README source paragraph.</p></article></main>')],
  ...['p', 'div', 'section'].map((tag) => [`/leaf/${tag}`, html(`<${tag} id="source" itemprop="articleBody">${leafText}</${tag}>`)]),
]);

const server = createServer((request, response) => {
  if (pages.has(request.url)) {
    response.setHeader('content-type', 'text/html; charset=utf-8');
    response.end(pages.get(request.url));
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
manifest.host_permissions = [...new Set([...(manifest.host_permissions || []), 'http://127.0.0.1/*', 'http://github.localhost/*'])];
await writeFile(manifestPath, JSON.stringify(manifest));

const executablePath = process.env.CHROME_FOR_TESTING || [
  '/Users/shaobo.chen/Library/Caches/ms-playwright/chromium-1234/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
].find(existsSync);
assert.ok(executablePath, 'Set CHROME_FOR_TESTING to an installed Chrome binary');

const browser = await chromium.launchPersistentContext(join(root, 'profile'), {
  executablePath, headless: true, viewport: { width: 1280, height: 900 },
  args: ['--enable-extensions', `--disable-extensions-except=${extensionPath}`, `--load-extension=${extensionPath}`, '--no-first-run', '--no-default-browser-check'],
});

try {
  const worker = browser.serviceWorkers()[0] || await browser.waitForEvent('serviceworker');
  await worker.evaluate(() => {
    globalThis.__readingScopeUpdates = [];
    chrome.runtime.onMessage.addListener((message, sender) => {
      if (message?.type === 'deep-research:from-page' && message.payload?.type === 'deep-research:page-context') {
        globalThis.__readingScopeUpdates.push({ tabId: sender.tab?.id, context: message.payload.context });
      }
    });
  });

  async function send(tabId, message) {
    return worker.evaluate(({ tabId, message }) => chrome.tabs.sendMessage(tabId, message), { tabId, message });
  }

  // Observe the real content-script protocol, including the source hash. DOM
  // tags alone can survive a later scope change and conceal missing blocks.
  async function requestEvent(tabId, message, expectedTypes) {
    return worker.evaluate(({ tabId, message, expectedTypes }) => new Promise((resolve, reject) => {
      const finish = (error, payload) => {
        clearTimeout(timer);
        chrome.runtime.onMessage.removeListener(listener);
        if (error) reject(error); else resolve(payload);
      };
      const listener = (event, sender) => {
        if (sender.tab?.id === tabId && event?.type === 'deep-research:from-page' && expectedTypes.includes(event.payload?.type)) {
          finish(null, event.payload);
        }
      };
      const timer = setTimeout(() => finish(new Error(`No ${expectedTypes.join('/')} from tab ${tabId}`)), 10_000);
      chrome.runtime.onMessage.addListener(listener);
      chrome.tabs.sendMessage(tabId, message).catch((error) => finish(error));
    }), { tabId, message, expectedTypes });
  }

  async function snapshot(tabId) {
    return (await requestEvent(tabId, { type: 'deep-research:request-full-document' }, ['deep-research:full-document'])).context;
  }

  async function openFixture(path, hostname) {
    const article = await browser.newPage();
    const fixtureUrl = new URL(path, origin);
    if (hostname) fixtureUrl.hostname = hostname;
    const url = fixtureUrl.href;
    await article.goto(url);
    await article.bringToFront();
    const tabId = await worker.evaluate(async (url) => {
      const tab = (await chrome.tabs.query({})).find((tab) => tab.url === url);
      if (!tab) throw new Error(`No article tab for ${url}`);
      await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['content.js'] });
      return tab.id;
    }, url);
    return { article, tabId, context: await snapshot(tabId) };
  }

  async function translate(tabId, block, text) {
    const receipt = await send(tabId, { type: 'deep-research:apply-translations', translations: [{ id: block.id, sourceText: block.text, text, targetLanguage: 'zh-CN' }] });
    assert.deepEqual(receipt.failedItems, []);
    assert.deepEqual(receipt.appliedIds, [block.id]);
  }

  const summary = {};
  {
    const { article, context } = await openFixture('/vitepress');
    assert.equal(context.blocks.length, 15);
    assert.ok(context.body.includes('Article paragraph 12'));
    assert.equal(context.scopeCoverage, 1);
    const sidebarBlocks = await article.locator('aside [data-deep-research-block]').count();
    assert.equal(sidebarBlocks, 0, 'sidebar links must not be read');
    summary.vitepressBlocks = context.blocks.length;
    await article.close();
  }
  {
    const { article, tabId, context: before } = await openFixture('/translation');
    assert.equal(before.blocks.length, 4);
    await translate(tabId, before.blocks[1], '这是一段译文内容。'.repeat(150));
    const after = await snapshot(tabId);
    assert.deepEqual(after.blocks, before.blocks, 'translating one root must not discard another');
    assert.equal(after.body, before.body);
    assert.equal(after.contentHash, before.contentHash, 'translation must preserve the source identity');
    assert.equal(after.scopeCoverage, before.scopeCoverage);
    assert.equal(after.scopePartial, before.scopePartial);
    summary.translatedScopeStable = true;
    await article.close();
  }
  {
    const { article, tabId, context: before } = await openFixture('/partial');
    assert.equal(before.scopePartial, true);
    await translate(tabId, before.blocks[1], '译文内容。'.repeat(1000));
    const after = await snapshot(tabId);
    assert.equal(after.contentHash, before.contentHash);
    assert.equal(after.scopeCoverage, before.scopeCoverage, 'translation must not inflate source coverage');
    assert.equal(after.scopePartial, true);
    assert.deepEqual(after.scopeWarnings, before.scopeWarnings);
    summary.partialWarningPreserved = true;
    const strip = article.locator('[data-deep-research-status] .status');
    const dismiss = article.locator('[data-deep-research-status] .dismiss');
    const partialNotice = { type: 'deep-research:reader-status', state: 'partial', label: 'Article text may be incomplete', detail: 'Read 3 blocks.' };
    await send(tabId, partialNotice);
    await expect(strip).toHaveClass(/visible/);
    await expect(strip).toHaveClass(/partial/);
    await expect(dismiss).toBeVisible();
    await dismiss.click();
    await expect(strip).not.toHaveClass(/visible/);
    // Hidden must also mean removed from the tab order and the accessibility
    // tree, not merely transparent.
    await expect.poll(() => strip.evaluate(element => getComputedStyle(element).visibility)).toBe('hidden');
    await expect(dismiss).toBeHidden();
    // A repeat of the same page-context update must not resurrect a notice the
    // reader just dismissed.
    await send(tabId, partialNotice);
    await expect(strip).not.toHaveClass(/visible/);
    await expect.poll(() => strip.evaluate(element => getComputedStyle(element).visibility)).toBe('hidden');
    await send(tabId, { type: 'deep-research:reader-status', state: 'loading', label: 'Reading article…', detail: '' });
    await expect(strip).toHaveClass(/visible/);
    await expect.poll(() => strip.evaluate(element => getComputedStyle(element).visibility)).toBe('visible');
    await expect(dismiss).toBeHidden();
    summary.partialStatusDismissible = true;
    await article.close();
  }
  for (const tag of ['p', 'div', 'section']) {
    const { article, tabId, context: before } = await openFixture(`/leaf/${tag}`);
    assert.equal(before.blocks.length, 1, `${tag} root must be read exactly once`);
    assert.equal(before.blocks[0].tag, tag);
    assert.equal(before.body, leafText);
    await translate(tabId, before.blocks[0], '正文译文。'.repeat(60));
    const after = await snapshot(tabId);
    assert.deepEqual(after.blocks, before.blocks);
    assert.equal(after.contentHash, before.contentHash);
    const anchor = await requestEvent(tabId, { type: 'deep-research:focus-anchor', anchor: { quote: 'A unique article opening.', contentHash: before.contentHash } }, ['deep-research:anchor-resolved', 'deep-research:anchor-unresolved']);
    assert.equal(anchor.type, 'deep-research:anchor-resolved', `${tag} root must support source anchors after translation`);
    await article.close();
  }
  summary.leafRootsReadAndAnchored = ['p', 'div', 'section'];
  for (const wrapped of [false, true]) {
    const { article, tabId, context: before } = await openFixture('/late');
    await worker.evaluate((tabId) => { globalThis.__readingScopeUpdates = globalThis.__readingScopeUpdates.filter((event) => event.tabId !== tabId); }, tabId);
    await article.evaluate((wrapped) => {
      const late = `<main id="late"><h2>Late section</h2><p>${'Late article source. '.repeat(200)}</p></main>`;
      document.getElementById('app').innerHTML = wrapped ? `<section>${late}</section>` : late;
    }, wrapped);
    // No explicit request or refresh: the MutationObserver must publish this.
    await expect.poll(() => worker.evaluate((tabId) => globalThis.__readingScopeUpdates.some((event) => event.tabId === tabId && event.context.body.includes('Late article source.')), tabId), { timeout: 10_000 }).toBe(true);
    const after = await worker.evaluate((tabId) => globalThis.__readingScopeUpdates.filter((event) => event.tabId === tabId).at(-1).context, tabId);
    assert.notEqual(after.contentHash, before.contentHash);
    assert.equal(after.blockCount, 4);
    assert.equal(after.scopeCoverage, 1);
    assert.equal(after.scopePartial, false);
    await article.close();
  }
  summary.lateSubtreesAutoRefreshed = ['candidate itself', 'candidate descendant'];
  {
    const { article, tabId, context } = await openFixture('/site-specific', 'github.localhost');
    assert.equal(context.scopeMode, 'site');
    assert.equal(context.body, 'README source paragraph.');
    await worker.evaluate((tabId) => { globalThis.__readingScopeUpdates = globalThis.__readingScopeUpdates.filter((event) => event.tabId !== tabId); }, tabId);
    await article.locator('#metadata').evaluate((node) => { node.textContent = 'Changed repository metadata.'; });
    await article.waitForTimeout(650);
    assert.equal(await worker.evaluate((tabId) => globalThis.__readingScopeUpdates.filter((event) => event.tabId === tabId).length, tabId), 0, 'site-specific roots must ignore metadata in an outer main');
    await article.locator('#readme p').evaluate((node) => { node.textContent = 'Updated README source paragraph.'; });
    await expect.poll(() => worker.evaluate((tabId) => globalThis.__readingScopeUpdates.some((event) => event.tabId === tabId && event.context.body === 'Updated README source paragraph.'), tabId), { timeout: 10_000 }).toBe(true);
    summary.siteSpecificMetadataIgnored = true;
    await article.close();
  }
  console.log(`reading-scope e2e passed: ${JSON.stringify(summary)}`);
} finally {
  await browser.close();
  server.close();
}
