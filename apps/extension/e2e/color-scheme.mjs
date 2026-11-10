/**
 * The Reader and the platform share one palette. Since dark mode was added,
 * this audit proves that both schemes come from that single source:
 *
 *   1. no surface carries a `light`/`dark` class, so two providers can never
 *      fight over the document scheme;
 *   2. the stored preference drives the panel, the history page and the
 *      injected controls, and `system` follows `prefers-color-scheme`;
 *   3. the generated stylesheet only ships the shared light set plus the
 *      shared dark overrides, never a Reader-only second palette.
 */
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { cp, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { chromium } from '../../web/node_modules/@playwright/test/index.mjs';
import tokens from '../../../packages/design-system/src/tokens.json' with { type: 'json' };
import darkOverrides from '../../../packages/design-system/src/dark.json' with { type: 'json' };
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

const LIGHT = {
  primary: tokens['color-primary'],
  surface: tokens['color-surface'],
  text: tokens['color-text'],
};
const DARK = {
  primary: darkOverrides['color-primary'],
  surface: darkOverrides['color-surface'],
  text: darkOverrides['color-text'],
};

const context = await chromium.launchPersistentContext(`${artifacts}/profile`, {
  executablePath,
  headless: process.env.READER_HEADLESS === '1',
  locale: 'zh-CN',
  colorScheme: 'light',
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
      scheme: root.dataset.readerScheme || '',
      colorScheme: root.style.colorScheme || styles.colorScheme,
      primary: styles.getPropertyValue('--reader-color-primary').trim(),
      surface: styles.getPropertyValue('--reader-color-surface').trim(),
      bodyBackground: body.backgroundColor,
      bodyColor: body.color,
      buttonColor: button ? getComputedStyle(button).color : null,
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

  // 1. Default preference is `system`; the emulated light OS gives the light set.
  const lightPalette = await readPalette(panel);
  assert.ok(!/\b(dark|light)\b/u.test(lightPalette.className), `no scheme class may be written onto <html>: ${JSON.stringify(lightPalette)}`);
  assert.equal(lightPalette.scheme, 'light', `system + light OS resolves to light: ${JSON.stringify(lightPalette)}`);
  assert.equal(lightPalette.primary, LIGHT.primary, 'the Reader paints the shared light primary');
  assert.equal(lightPalette.surface, LIGHT.surface, 'the Reader paints the shared light surface');
  assert.equal(toHex(lightPalette.bodyBackground), LIGHT.surface, 'the panel surface uses the shared light surface');
  assert.equal(toHex(lightPalette.bodyColor), LIGHT.text, 'the panel text uses the shared light text token');

  // 2. `system` follows the OS scheme without any stored preference.
  await panel.emulateMedia({ colorScheme: 'dark' });
  await panel.waitForFunction(() => document.documentElement.dataset.readerScheme === 'dark', null, { timeout: 10_000 });
  const systemDark = await readPalette(panel);
  assert.equal(systemDark.surface, DARK.surface, `system mode follows the dark OS: ${JSON.stringify(systemDark)}`);
  assert.equal(toHex(systemDark.bodyBackground), DARK.surface, 'the panel surface follows the dark scheme');
  await panel.emulateMedia({ colorScheme: 'light' });
  await panel.waitForFunction(() => document.documentElement.dataset.readerScheme === 'light', null, { timeout: 10_000 });

  // 3. The settings switch persists one preference, and both schemes repaint.
  await panel.locator('#settings-button').click();
  await panel.locator('#color-scheme').selectOption('dark');
  await panel.waitForFunction(() => document.documentElement.dataset.readerScheme === 'dark', null, { timeout: 10_000 });
  const darkPalette = await readPalette(panel);
  assert.equal(darkPalette.primary, DARK.primary, `explicit dark paints the shared dark primary: ${JSON.stringify(darkPalette)}`);
  assert.equal(darkPalette.surface, DARK.surface, 'explicit dark paints the shared dark surface');
  assert.equal(toHex(darkPalette.bodyBackground), DARK.surface, 'explicit dark repaints the panel surface');
  assert.ok(!/\b(dark|light)\b/u.test(darkPalette.className), 'the scheme is never written as a class');
  assert.equal(await panel.evaluate(async () => (await chrome.storage.local.get('readerColorScheme')).readerColorScheme), 'dark');
  await panel.screenshot({ path: `${artifacts}/sidepanel-palette-dark.png` });

  await panel.locator('#color-scheme').selectOption('light');
  await panel.waitForFunction(() => document.documentElement.dataset.readerScheme === 'light', null, { timeout: 10_000 });
  const backToLight = await readPalette(panel);
  assert.equal(backToLight.surface, LIGHT.surface, 'switching back restores the shared light surface');
  await panel.screenshot({ path: `${artifacts}/sidepanel-palette-light.png` });

  // 4. The history page reads the same preference.
  await panel.evaluate(async () => chrome.storage.local.set({ readerColorScheme: 'dark' }));
  const history = await context.newPage();
  await history.goto(`chrome-extension://${id}/reading-history.html`);
  await history.waitForSelector('#history-root .history-shell');
  await history.waitForFunction(() => document.documentElement.dataset.readerScheme === 'dark', null, { timeout: 10_000 });
  const historyPalette = await history.evaluate(() => ({
    className: document.documentElement.className,
    scheme: document.documentElement.dataset.readerScheme,
    surface: getComputedStyle(document.documentElement).getPropertyValue('--reader-color-surface').trim(),
  }));
  assert.ok(!/\b(dark|light)\b/u.test(historyPalette.className), `the history page must not carry a scheme class: ${JSON.stringify(historyPalette)}`);
  assert.equal(historyPalette.scheme, 'dark', 'the history page follows the stored preference');
  assert.equal(historyPalette.surface, DARK.surface, 'the history page paints the shared dark surface');

  // 5. The injected controls read the same preference and repaint live.
  const tabId = await worker.evaluate(async originUrl => {
    const [tab] = await chrome.tabs.query({ url: `${originUrl}/article` });
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
      scheme: host.dataset.readerScheme,
      colorScheme: host.style.colorScheme,
      primary: styles.getPropertyValue('--reader-color-primary').trim(),
    };
  });
  assert.ok(injected, 'the injected controls expose the shared token host');
  assert.equal(injected.scheme, 'dark', `the injected controls follow the stored scheme: ${JSON.stringify(injected)}`);
  assert.equal(injected.colorScheme, 'dark', 'the injected controls state the Reader scheme explicitly');
  assert.equal(injected.primary, DARK.primary, 'the injected controls use the shared dark primary token');

  await panel.evaluate(async () => chrome.storage.local.set({ readerColorScheme: 'light' }));
  await article.waitForFunction(() => document.querySelector('[data-deep-research-design-host]')?.dataset.readerScheme === 'light', null, { timeout: 10_000 });
  const injectedLight = await article.evaluate(() => {
    const host = document.querySelector('[data-deep-research-design-host]');
    return { scheme: host.dataset.readerScheme, primary: getComputedStyle(host).getPropertyValue('--reader-color-primary').trim() };
  });
  assert.equal(injectedLight.primary, LIGHT.primary, 'an in-page preference change repaints the injected controls');
  await worker.evaluate(async tab => chrome.tabs.sendMessage(tab, { type: 'deep-research:request-page' }).catch(() => {}), tabId);

  // 6. The generated stylesheet pairs the shared light set with the shared
  // dark overrides; a hand-written `.dark` palette would drift.
  const readerCss = await readFile(new URL('../design-system/tokens.css', import.meta.url), 'utf8');
  assert.ok(!/^\.dark\s*\{/mu.test(readerCss), 'the Reader stylesheet must not declare a .dark block');
  assert.ok(readerCss.includes(':root[data-reader-scheme="dark"]'), 'the Reader stylesheet exposes the shared dark scheme');
  assert.ok(readerCss.includes(`--reader-color-surface: ${LIGHT.surface};`), 'the Reader stylesheet uses the shared light values');
  assert.ok(readerCss.includes(`--reader-color-surface: ${DARK.surface};`), 'the Reader stylesheet uses the shared dark values');

  await writeFile(`${artifacts}/report.json`, JSON.stringify({ lightPalette, systemDark, darkPalette, historyPalette, injected, injectedLight }, null, 2));
  console.log(JSON.stringify({
    pass: true,
    checks: [
      'system + light OS paints the shared light palette without a scheme class',
      'system + dark OS follows the OS palette',
      'the settings switch persists one preference and repaints both schemes',
      'the history page follows the same preference',
      'injected controls follow the preference and repaint live',
      'the generated stylesheet pairs the shared light set with the shared dark overrides',
    ],
    artifacts,
  }, null, 2));
} finally {
  await context.close();
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
}
