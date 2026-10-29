import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdtemp } from 'node:fs/promises';
import { createServer } from 'node:net';
import { chromium } from '../../web/node_modules/@playwright/test/index.mjs';
import { tempPath } from './temp-paths.mjs';

const executablePath = process.env.CHROME_FOR_TESTING || [
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
].find(existsSync);
if (!executablePath) throw new Error('Set CHROME_FOR_TESTING to a full Chrome/Chromium binary');
const listener = createServer();
await new Promise(resolve => listener.listen(0, '127.0.0.1', resolve));
const port = listener.address().port;
await new Promise(resolve => listener.close(resolve));
const profile = await mkdtemp(tempPath('reader-install-resume-'));
const context = await chromium.launchPersistentContext(profile, {
  executablePath, headless: true, ignoreDefaultArgs: ['--disable-extensions'],
  args: ['--enable-extensions', '--enable-unsafe-extension-debugging', `--remote-debugging-port=${port}`],
});
try {
  const page = await context.newPage();
  await page.route('https://techradar.top/**', route => route.fulfill({ body: '<h1>Radar fixture</h1>' }));
  await page.goto('https://techradar.top/radar');
  await context.route('https://example.com/article**', route => route.fulfill({ body: '<h1>Article fixture</h1>' }));
  await page.evaluate(() => {
    window.addEventListener('message', event => {
      if (event.origin === location.origin && event.data?.type === 'deep-research:install-resumed') {
        document.documentElement.dataset.readerResumed = 'true';
      }
    });
  });
  const source = 'https://example.com/article?deep-research-source=radar&deep-research-summary=install-test&deep-research-platform=https%3A%2F%2Ftechradar.top';
  await page.evaluate(url => sessionStorage.setItem('dr:reader-pending-install', JSON.stringify({
    id: 'install-test', url, createdAt: Date.now(), status: 'pending',
  })), source);
  const browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
  try {
    const session = await browser.newBrowserCDPSession();
    const [article] = await Promise.all([
      context.waitForEvent('page', { timeout: 20_000 }),
      session.send('Extensions.loadUnpacked', { path: new URL('../.output/chrome-mv3', import.meta.url).pathname }),
    ]);
    await article.waitForURL('https://example.com/article**', { timeout: 20_000, waitUntil: 'commit' });
    assert.equal(article.url(), source);
    await page.waitForFunction(() => sessionStorage.getItem('dr:reader-pending-install') === null);
    await page.waitForFunction(() => document.documentElement.dataset.readerResumed === 'true');
    console.log('PASS installation resumes the exact article and clears the pending request');
  } finally { await browser.close(); }
} finally { await context.close(); }
