import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { chromium } from '../../web/node_modules/@playwright/test/index.mjs';

const extensionPath = new URL('../.output/chrome-mv3', import.meta.url).pathname;
const fixturePath = new URL('./fixture.html', import.meta.url);
const fixtureServer = createServer(async (_request, response) => {
  response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
  response.end(await readFile(fixturePath));
});
await new Promise((resolve, reject) => {
  fixtureServer.once('error', reject);
  fixtureServer.listen(8766, '127.0.0.1', resolve);
});

const requestLogPath = `/private/tmp/deep-research-reader-worker-requests-${Date.now()}.jsonl`;
const provider = spawn(process.execPath, [new URL('./fake-openai.mjs', import.meta.url).pathname], {
  env: { ...process.env, PORT: '8800', FAKE_DELAY_MS: '120', FAKE_REQUEST_LOG: requestLogPath },
  stdio: ['ignore', 'pipe', 'pipe'],
});
const executablePath = process.env.CHROME_FOR_TESTING
  || [
    '/Users/shaobo.chen/Library/Caches/ms-playwright/chromium-1234/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  ].find(existsSync);
if (!executablePath) throw new Error('找不到 Chrome，请设置 CHROME_FOR_TESTING');

const profilePath = `/private/tmp/deep-research-reader-worker-${Date.now()}`;
const context = await chromium.launchPersistentContext(profilePath, {
  executablePath,
  headless: process.env.READER_HEADLESS === '1',
  viewport: { width: 1280, height: 900 },
    args: ['--enable-extensions', `--disable-extensions-except=${extensionPath}`, `--load-extension=${extensionPath}`, '--no-first-run', '--no-default-browser-check'],
});

try {
  const serviceWorker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
  const extensionId = new URL(serviceWorker.url()).host;
  const resumeAlarm = await serviceWorker.evaluate(async () => {
    const alarm = await chrome.alarms?.get('deep-research-reader-resume');
    return alarm ? { name: alarm.name, periodInMinutes: alarm.periodInMinutes } : null;
  });
  if (!resumeAlarm) throw new Error('durable translation resume alarm was not scheduled');
  const fixture = await context.newPage();
  await fixture.goto('http://127.0.0.1:8766/fixture.html', { waitUntil: 'domcontentloaded' });
  const panel = await context.newPage();
  await panel.goto(`chrome-extension://${extensionId}/sidepanel.html`, { waitUntil: 'domcontentloaded' });
  await fixture.bringToFront();
  const activation = await serviceWorker.evaluate(async () => {
    const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    if (!tab?.id || tab.windowId === undefined) throw new Error('fixture tab not active');
    await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['content.js'] });
    await chrome.tabs.sendMessage(tab.id, { type: 'deep-research:request-page' });
    return { tabId: tab.id, windowId: tab.windowId };
  });
  await panel.waitForTimeout(500);
  // The side-panel document can finish loading after the first page-context
  // message. Request it again through the extension protocol and wait for the
  // actual page view before configuring the provider.
  await serviceWorker.evaluate(async (tabId) => {
    await chrome.tabs.sendMessage(tabId, { type: 'deep-research:request-page' });
  }, activation.tabId);
  await panel.locator('#page-view').waitFor({ state: 'visible', timeout: 10_000 });
  await panel.locator('#settings-button').click();
  await panel.locator('#provider-kind').selectOption('custom');
  await panel.locator('#provider-url').fill('http://127.0.0.1:8800/v1');
  await panel.locator('#provider-model').fill('fake-reader');
  await panel.locator('#provider-key').fill('test-key');
  await panel.locator('#request-provider-origin').uncheck();
  await panel.locator('#save-settings').click();
  await panel.locator('#settings-notice').waitFor({ state: 'visible', timeout: 10_000 });
  await panel.locator('#close-settings').click();
  await panel.locator('#translate-all').click();
  await panel.waitForFunction(() => document.querySelector('#text-progress-value')?.textContent !== '0 / 0', null, { timeout: 10_000 });

  // The worker owns the requests now; closing the panel must not cancel them.
  // A full browser/worker termination recovery run remains a separate
  // lifecycle gate because Chrome for Testing unloads this temporary
  // extension context when runtime.reload() is called.
  await panel.close();

  // The worker owns the requests now; closing the panel must not cancel them.
  await fixture.waitForSelector('[data-deep-research-image-overlay]', { timeout: 30_000 });
  const translatedWhileClosed = await fixture.evaluate(() => ({
    overlays: document.querySelectorAll('[data-deep-research-image-overlay]').length,
    textTranslations: document.querySelectorAll('[data-deep-research-translation]').length,
  }));
  // The last image overlay is applied just before the worker commits its
  // terminal job state. Give IndexedDB that final write a bounded turn before
  // reopening the disposable panel.
  await fixture.waitForTimeout(500);
  const requestCountBeforeReopen = (await readFile(requestLogPath, 'utf8').catch(() => '')).trim().split('\n').filter(Boolean).length;

  // Recreating the disposable panel must re-attach to the durable job and
  // replay cached results even though the original panel was destroyed.
  const reopened = await context.newPage();
  await reopened.goto(`chrome-extension://${extensionId}/sidepanel.html`, { waitUntil: 'domcontentloaded' });
  await reopened.bringToFront();
  await fixture.bringToFront();
  await fixture.waitForTimeout(500);
  await reopened.bringToFront();
  const requestCountAfterReopen = (await readFile(requestLogPath, 'utf8').catch(() => '')).trim().split('\n').filter(Boolean).length;
  const resumedNotice = await reopened.locator('#notice').innerText().catch(() => '');
  const resumed = await fixture.evaluate(() => ({
    overlays: document.querySelectorAll('[data-deep-research-image-overlay]').length,
    textTranslations: document.querySelectorAll('[data-deep-research-translation]').length,
  }));
  if (!translatedWhileClosed.overlays || !translatedWhileClosed.textTranslations) throw new Error(`worker did not finish after panel close: ${JSON.stringify(translatedWhileClosed)}`);
  if (!resumed.overlays || !resumed.textTranslations) throw new Error(`cached results were not reattached: ${JSON.stringify(resumed)}`);
  if (requestCountAfterReopen !== requestCountBeforeReopen) throw new Error(`completed job reopened with new model requests: ${JSON.stringify({ requestCountBeforeReopen, requestCountAfterReopen })}`);

  // Citation location gate: an unchanged unique quote resolves, a duplicate
  // quote fails safely, and a stale content hash is rejected instead of
  // jumping to a merely similar paragraph.
  const exactQuote = await fixture.locator('#target').innerText();
  await serviceWorker.evaluate(async ({ tabId, quote }) => {
    await chrome.tabs.sendMessage(tabId, { type: 'deep-research:focus-anchor', anchor: { quote } });
  }, { tabId: activation.tabId, quote: exactQuote });
  await reopened.waitForFunction(() => document.querySelector('#notice')?.textContent?.includes('已回到原文证据'), null, { timeout: 5_000 });
  await fixture.evaluate((quote) => {
    const duplicate = document.createElement('p');
    duplicate.id = 'duplicate-evidence-target';
    duplicate.textContent = quote;
    document.querySelector('article')?.append(duplicate);
  }, exactQuote);
  await serviceWorker.evaluate(async ({ tabId, quote }) => {
    await chrome.tabs.sendMessage(tabId, { type: 'deep-research:focus-anchor', anchor: { quote } });
  }, { tabId: activation.tabId, quote: exactQuote });
  await reopened.waitForFunction(() => document.querySelector('#notice')?.textContent?.includes('多个可能位置'), null, { timeout: 5_000 });
  await fixture.evaluate(() => document.querySelector('#duplicate-evidence-target')?.remove());
  await serviceWorker.evaluate(async ({ tabId, quote }) => {
    await chrome.tabs.sendMessage(tabId, { type: 'deep-research:focus-anchor', anchor: { quote, contentHash: 'stale-content-hash' } });
  }, { tabId: activation.tabId, quote: exactQuote });
  await reopened.waitForFunction(() => document.querySelector('#notice')?.textContent?.includes('原文已变化'), null, { timeout: 5_000 });

  await fixture.evaluate(() => { document.querySelector('#target').textContent += ' The source changed after the answer.'; });
  // Request one fresh context as a deterministic boundary after the DOM edit;
  // the observer also emits this message, while the explicit request keeps
  // this assertion independent of the observer debounce timing.
  await serviceWorker.evaluate(async (tabId) => {
    await chrome.tabs.sendMessage(tabId, { type: 'deep-research:request-page' });
  }, activation.tabId);
  try {
    await reopened.locator('#notice').filter({ hasText: '页面内容已变化' }).waitFor({ state: 'visible', timeout: 10_000 });
  } catch (error) {
    throw new Error(`stale evidence notice missing: ${JSON.stringify({ notice: await reopened.locator('#notice').innerText().catch(() => ''), body: (await reopened.locator('body').innerText().catch(() => '')).slice(-1200), target: await fixture.locator('#target').innerText() })}; ${error.message}`);
  }
  console.log(JSON.stringify({ extensionId, activation, resumeAlarm, panelClosed: true, translatedWhileClosed, resumed, resumedNotice, requestCountBeforeReopen, requestCountAfterReopen, citation: { unchangedResolved: true, duplicateRejected: true, staleHashRejected: true }, staleEvidenceInvalidated: true }, null, 2));
} finally {
  await context.close();
  provider.kill('SIGTERM');
  await new Promise((resolve) => provider.once('exit', resolve));
  await new Promise((resolve) => fixtureServer.close(resolve));
}
