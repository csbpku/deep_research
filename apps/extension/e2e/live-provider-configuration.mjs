import assert from 'node:assert/strict';
import { selectSettingsModel } from './settings-model-picker.mjs';
import { cp, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { chromium } from '../../web/node_modules/@playwright/test/index.mjs';
import { join } from 'node:path';
import { tempDir, tempPath } from './temp-paths.mjs';

if (process.env.READER_LIVE !== '1') {
  console.log('Skipped: set READER_LIVE=1 and READER_LIVE_MODEL to run a real model request.');
  process.exit(0);
}
assert.ok(process.env.READER_LIVE_MODEL, 'Select the live test model explicitly with READER_LIVE_MODEL');

const artifacts = await mkdtemp(join(tempDir(), 'reader-live-provider-configuration-'));
const extension = `${artifacts}/extension`;
await cp(new URL('../.output/chrome-mv3/', import.meta.url).pathname, extension, { recursive: true });
const manifest = JSON.parse(await readFile(`${extension}/manifest.json`, 'utf8'));
// Isolated live-provider fixture only; the production archive keeps optional access.
manifest.host_permissions = ['http://127.0.0.1/*'];
await writeFile(`${extension}/manifest.json`, JSON.stringify(manifest));
const context = await chromium.launchPersistentContext(`${artifacts}/profile`, {
  executablePath: process.env.CHROME_FOR_TESTING || '/Users/shaobo.chen/Library/Caches/ms-playwright/chromium-1234/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing',
  headless: true, viewport: { width: 430, height: 900 },
  args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`, '--no-first-run'],
});
try {
  const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
  const id = new URL(worker.url()).host;
  const page = await context.newPage();
  await page.goto(`chrome-extension://${id}/sidepanel.html`);
  await page.waitForFunction(() => document.documentElement.dataset.readerReady === 'true');
  await page.locator('#settings-button').click();
  await page.locator('#provider-kind').selectOption('local-proxy', { force: true });
  const started = Date.now();
  await page.locator('#refresh-models').click();
  await page.waitForFunction(() => document.querySelector('#model-discovery-status')?.dataset.state === 'ready', null, { timeout: 12000 });
  const discoveryMs = Date.now() - started;
  assert.equal(await page.locator('#provider-url').inputValue(), 'http://127.0.0.1:8317/v1');
  assert.equal(await page.locator('#provider-key').inputValue(), '');
  const models = await page.locator('#provider-model-list option').evaluateAll(items => items.map(n => n.value).filter(Boolean));
  assert.ok(models.length > 0);
  const selected = process.env.READER_LIVE_MODEL;
  assert.ok(models.includes(selected), 'The configured live test model must be offered by this service');
  await selectSettingsModel(page, selected);
  await page.locator('#save-settings').click();
  await page.waitForFunction(() => document.querySelector('#settings-notice')?.textContent?.includes('已保存'));
  await page.locator('#test-provider').click();
  await page.waitForFunction(() => ['verified', 'error'].includes(document.querySelector('#provider-test-status')?.dataset.state), null, { timeout: 15000 });
  const state = await page.locator('#provider-test-status').getAttribute('data-state');
  const status = await page.locator('#provider-test-status').innerText();
  const report = { version: manifest.version, artifacts, realService: 'http://127.0.0.1:8317/v1', keyEmpty: true, modelCount: models.length, discoveryMs, selectedModel: selected, modelTestState: state, modelTestStatus: status, testOriginPregrantedInIsolatedFixture: true };
  await page.locator('#local-provider-settings').scrollIntoViewIfNeeded();
  await page.screenshot({ path: `${artifacts}/live-configuration.png` });
  await writeFile(`${artifacts}/report.json`, JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify(report, null, 2));
  assert.equal(state, 'verified', status);
} finally { await context.close(); }
