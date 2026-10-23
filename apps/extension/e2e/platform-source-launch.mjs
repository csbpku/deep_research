import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { chromium } from '../../web/node_modules/@playwright/test/index.mjs';
import { tempDir, tempPath } from './temp-paths.mjs';

const platformOrigin = 'https://techradar.top';
const storeUrl = 'https://chromewebstore.google.com/detail/bldpmkepljipbadeegednfinnilgoedl';
const sourceUrl = new URL('https://example.com/article?lang=en#architecture');
sourceUrl.searchParams.set('deep-research-source', 'radar');
sourceUrl.searchParams.set('deep-research-summary', 'source-launch-test');
const installedSourceUrl = new URL(sourceUrl);
installedSourceUrl.searchParams.set('deep-research-platform', platformOrigin);

const extensionPath = new URL('../.output/chrome-mv3', import.meta.url).pathname;
const executablePath = process.env.CHROME_FOR_TESTING
  || [
    '/Users/shaobo.chen/Library/Caches/ms-playwright/chromium-1234/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  ].find(existsSync);
if (!executablePath) throw new Error('找不到 Chrome for Testing，请设置 CHROME_FOR_TESTING');

async function routeFixtures(page) {
  await page.route(`${platformOrigin}/**`, async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === '/radar') {
      await route.fulfill({
        contentType: 'text/html; charset=utf-8',
        body: `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>雷达测试</title><button id="open-source" data-reader-launch-source="${sourceUrl}">打开原文</button><script>document.querySelector('#open-source').addEventListener('click', () => { window.location.assign('${storeUrl}'); });</script></html>`,
      });
      return;
    }
    if (url.pathname === '/reading/install') {
      const returnTo = url.searchParams.get('returnTo') || '';
      await route.fulfill({
        contentType: 'text/html; charset=utf-8',
        body: `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>安装 Reader</title><h1>安装后继续阅读</h1><a id="article" href="${returnTo}" target="_blank" rel="noopener noreferrer">打开这篇原文</a></html>`,
      });
      return;
    }
    await route.abort();
  });
  await page.route(storeUrl, route => route.fulfill({ contentType: 'text/html', body: '<h1>Reader on Chrome Web Store</h1>' }));
  await page.route('https://example.com/article**', (route) => route.fulfill({
    contentType: 'text/html; charset=utf-8',
    body: '<!doctype html><html><meta charset="utf-8"><title>Article</title><article>Test source article</article></html>',
  }));
}

async function verifyWithoutExtension() {
  const context = await chromium.launchPersistentContext(tempPath(`reader-source-no-extension-${Date.now()}`), {
    executablePath,
    headless: true,
    viewport: { width: 980, height: 760 },
    args: ['--no-first-run', '--no-default-browser-check'],
  });
  try {
    const page = await context.newPage();
    await routeFixtures(page);
    await page.goto(`${platformOrigin}/radar`);
    const destination = page.waitForRequest(request => request.isNavigationRequest() && request.url().startsWith(storeUrl), { timeout: 15000 });
    await page.getByRole('button', { name: '打开原文' }).click();
    assert.equal((await destination).url(), storeUrl);
    console.log('PASS no-extension route: Chrome Web Store opens directly');
  } finally {
    await context.close();
  }
}

async function verifyWithExtension() {
  const context = await chromium.launchPersistentContext(tempPath(`reader-source-with-extension-${Date.now()}`), {
    executablePath,
    headless: true,
    viewport: { width: 980, height: 760 },
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
    const page = await context.newPage();
    await routeFixtures(page);
    await page.goto(`${platformOrigin}/radar`);
    const sourcePromise = context.waitForEvent('page', { timeout: 15_000 });
    await page.getByRole('button', { name: '打开原文' }).click();
    const source = await sourcePromise;
    await source.waitForLoadState('domcontentloaded');
    assert.equal(source.url(), installedSourceUrl.toString(), '已安装时应直接在新标签页打开带雷达上下文的原文');

    const extensionId = new URL(worker.url()).host;
    const extensionPages = context.pages().filter((candidate) => candidate.url().startsWith(`chrome-extension://${extensionId}/`));
    console.log(`PASS installed-extension route: source opened; extension pages observed=${extensionPages.map((candidate) => new URL(candidate.url()).pathname).join(',') || 'none'}`);
  } finally {
    await context.close();
  }
}

await verifyWithoutExtension();
await verifyWithExtension();
