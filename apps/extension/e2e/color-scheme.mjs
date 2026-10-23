/**
 * The Reader and the platform share one palette, one radius scale and one
 * type scale. The Reader renders a single scheme, so this audit proves two
 * things instead of a mode switch:
 *
 *   1. no surface can end up with a `light`/`dark` class or a second palette,
 *      so the panel, the history page and the injected controls always agree;
 *   2. every colour the Reader paints comes from the shared token file, never
 *      from a literal that only the extension knows about.
 */
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { cp, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { chromium } from '../../web/node_modules/@playwright/test/index.mjs';
import tokens from '../../../packages/design-system/src/tokens.json' with { type: 'json' };
import { join } from 'node:path';
import { tempDir, tempPath } from './temp-paths.mjs';

const artifacts = await mkdtemp(join(tempDir(), 'reader-palette-'));
const server = createServer((request, response) => {
  response.setHeader('content-type', 'text/html; charset=utf-8');
  response.end('<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Palette fixture</title></head><body><article><h1>Palette fixture</h1><p id="target">The Reader controls follow the shared palette.</p></article></body></html>');
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${server.address().port}`;

const extension = `${artifacts}/extension`;
await cp(new URL('../.output/chrome-mv3', import.meta.url).pathname, extension, { recursive: true });
const manifest = JSON.parse(await readFile(`${extension}/manifest.json`, 'utf8'));
manifest.host_permissions = ['http://127.0.0.1/*'];
await writeFile(`${extension}/manifest.json`, JSON.stringify(manifest));

const executablePath = process.env.CHROME_FOR_TESTING || [
  '/Users/shaobo.chen/Library/Caches/ms-playwright/chromium-1234/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
].find(existsSync);

const PRIMARY = tokens['color-primary'];
const SURFACE = tokens['color-surface'];
const TEXT = tokens['color-text'];

const context = await chromium.launchPersistentContext(`${artifacts}/profile`, {
  executablePath,
  headless: process.env.READER_HEADLESS === '1',
  locale: 'zh-CN',
  viewport: { width: 420, height: 820 },
  args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`],
});

function toHex(color) {
  const match = color.match(/rgba?\(\s*(\d+)[,\s]+(\d+)[,\s]+(\d+)/u);
  if (!match) return color;
  return `#${match.slice(1, 4).map((part) => Number(part).toString(16).padStart(2, '0')).join('')}`;
}

async function readPalette(page) {
  return page.evaluate(() => {
    const root = document.documentElement;
    const styles = getComputedStyle(root);
    const body = getComputedStyle(document.body);
    const button = document.querySelector('#nav-chat');
    return {
      className: root.className,
      colorScheme: root.style.colorScheme || styles.colorScheme,
      primary: styles.getPropertyValue('--reader-color-primary').trim(),
      surface: styles.getPropertyValue('--reader-color-surface').trim(),
      bodyBackground: body.backgroundColor,
      bodyColor: body.color,
      buttonColor: button ? getComputedStyle(button).color : null,
      // A second scheme would leave a persisted preference behind.
      stored: localStorage.getItem('readerColorScheme'),
    };
  });
}

try {
  const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
  const id = new URL(worker.url()).host;

  const article = await context.newPage();
  await article.goto(`${origin}/article`);

  const panel = await context.newPage();
  await panel.goto(`chrome-extension://${id}/sidepanel.html`);
  await panel.waitForFunction(() => document.documentElement.dataset.readerReady === 'true');

  // 1. The Reader renders one scheme and never labels the document with one.
  const palette = await readPalette(panel);
  assert.ok(!/\b(dark|light)\b/u.test(palette.className), `no scheme class may be written onto <html>: ${JSON.stringify(palette)}`);
  assert.equal(palette.stored, null, 'the Reader must not persist a colour scheme preference');
  assert.equal(palette.primary, PRIMARY, 'the Reader paints the shared primary token');
  assert.equal(palette.surface, SURFACE, 'the Reader paints the shared surface token');
  assert.equal(toHex(palette.bodyBackground), SURFACE, 'the panel surface uses the shared surface token');
  assert.equal(toHex(palette.bodyColor), TEXT, 'the panel text uses the shared text token');

  // 2. No appearance switch is offered, so the palette cannot diverge.
  await panel.locator('#settings-button').click();
  assert.equal(await panel.locator('#reader-color-scheme').count(), 0, 'the Reader must not offer a colour scheme switch');
  await panel.screenshot({ path: `${artifacts}/sidepanel-palette.png` });

  // 3. The history page reads the same palette as the side panel.
  const history = await context.newPage();
  await history.goto(`chrome-extension://${id}/reading-history.html`);
  await history.waitForSelector('#history-root .history-shell');
  const historyPalette = await history.evaluate(() => ({
    className: document.documentElement.className,
    primary: getComputedStyle(document.documentElement).getPropertyValue('--reader-color-primary').trim(),
  }));
  assert.ok(!/\b(dark|light)\b/u.test(historyPalette.className), `the history page must not carry a scheme class: ${JSON.stringify(historyPalette)}`);
  assert.equal(historyPalette.primary, PRIMARY, 'the history page uses the same shared primary token');

  // 4. The injected page controls use the same single palette.
  // The extension page is focused at this point, so the fixture tab has to be
  // selected explicitly rather than taken from the active tab.
  const workerReady = await worker.evaluate(async origin => {
    const [tab] = await chrome.tabs.query({ url: `${origin}/article` });
    if (!tab?.id) throw new Error('fixture tab was not found');
    await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['content.js'] });
    return tab.id;
  }, origin);
  await article.waitForSelector('[data-deep-research-dock]', { timeout: 10_000 });
  const injected = await article.evaluate(() => {
    const host = document.querySelector('[data-deep-research-design-host]');
    if (!host) return null;
    const styles = getComputedStyle(host);
    return {
      colorScheme: host.style.colorScheme,
      primary: styles.getPropertyValue('--reader-color-primary').trim(),
    };
  });
  assert.ok(injected, 'the injected controls expose the shared token host');
  assert.equal(injected.colorScheme, 'light', 'the injected controls state the Reader scheme explicitly');
  assert.equal(injected.primary, PRIMARY, 'the injected controls use the shared primary token');

  // 5. The generated stylesheet carries exactly one palette.
  const readerCss = await readFile(new URL('../design-system/tokens.css', import.meta.url), 'utf8');
  assert.ok(!/^\.dark\s*\{/mu.test(readerCss), 'the Reader stylesheet must not declare a second palette');
  assert.ok(readerCss.includes(`--reader-color-primary: ${PRIMARY};`), 'the Reader stylesheet uses the shared token values');

  await writeFile(`${artifacts}/report.json`, JSON.stringify({ palette, historyPalette, injected }, null, 2));
  console.log(JSON.stringify({ pass: true, artifacts, palette, historyPalette, injected }, null, 2));
} finally {
  await context.close();
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
}
