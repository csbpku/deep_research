import { createServer } from 'node:http';
import { readFile, readFile as readTextFile, unlink } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { chromium } from '../../web/node_modules/@playwright/test/index.mjs';

const extensionPath = new URL('../.output/chrome-mv3', import.meta.url).pathname;
const fixturePath = new URL('./fixture.html', import.meta.url);
const fixturePort = 8768;
const providerPort = 8802;
const profilePath = `/private/tmp/deep-research-reader-worker-restart-${Date.now()}`;
const requestLogPath = `/private/tmp/deep-research-reader-worker-requests-${Date.now()}.jsonl`;
const stableFixtureHtml = (await readFile(fixturePath, 'utf8')).replace(/<script>[\s\S]*?<\/script>/u, '');

const fixtureServer = createServer(async (_request, response) => {
  response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
  response.end(stableFixtureHtml);
});
await new Promise((resolve, reject) => {
  fixtureServer.once('error', reject);
  fixtureServer.listen(fixturePort, '127.0.0.1', resolve);
});

const provider = spawn(process.execPath, [new URL('./fake-openai.mjs', import.meta.url).pathname], {
  env: {
    ...process.env,
    PORT: String(providerPort),
    FAKE_DELAY_MS: '1500',
    FAKE_REQUEST_LOG: requestLogPath,
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});
const executablePath = process.env.CHROME_FOR_TESTING
  || [
    '/Users/shaobo.chen/Library/Caches/ms-playwright/chromium-1234/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  ].find(existsSync);
if (!executablePath) throw new Error('找不到 Chrome，请设置 CHROME_FOR_TESTING');

function launch() {
  return chromium.launchPersistentContext(profilePath, {
    executablePath,
    headless: process.env.READER_HEADLESS === '1',
    viewport: { width: 1280, height: 900 },
    args: ['--enable-extensions', `--disable-extensions-except=${extensionPath}`, `--load-extension=${extensionPath}`, '--no-first-run', '--no-default-browser-check'],
  });
}

function waitFor(predicate, { timeout = 20_000, interval = 100, label = '条件' } = {}) {
  const startedAt = Date.now();
  return new Promise((resolve, reject) => {
    const tick = async () => {
      try {
        const value = await predicate();
        if (value) {
          resolve(value);
          return;
        }
      } catch (error) {
        if (Date.now() - startedAt >= timeout) {
          reject(error);
          return;
        }
      }
      if (Date.now() - startedAt >= timeout) {
        reject(new Error(`等待${label}超时（${timeout}ms）`));
        return;
      }
      setTimeout(() => void tick(), interval);
    };
    void tick();
  });
}

async function readLocalState(page) {
  return page.evaluate(async () => new Promise((resolve, reject) => {
    // Keep this reader-side inspection in lockstep with the extension's
    // IndexedDB migration. Version 4 adds the local annotations store while
    // preserving the jobs/taskInputs stores used by this recovery assertion.
    const request = indexedDB.open('deep-research-reader', 4);
    request.onerror = () => reject(request.error || new Error('无法打开阅读数据库'));
    request.onsuccess = () => {
      const database = request.result;
      const transaction = database.transaction(['jobs', 'taskInputs'], 'readonly');
      const jobsRequest = transaction.objectStore('jobs').getAll();
      const inputsRequest = transaction.objectStore('taskInputs').getAll();
      transaction.oncomplete = () => {
        database.close();
        resolve({ jobs: jobsRequest.result, taskInputs: inputsRequest.result });
      };
      transaction.onerror = () => reject(transaction.error || new Error('读取阅读数据库失败'));
    };
  }));
}

async function activatePage(worker, fixture) {
  await fixture.bringToFront();
  return worker.evaluate(async () => {
    const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    if (!tab?.id) throw new Error('原网页标签页未激活');
    await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['content.js'] });
    await chrome.tabs.sendMessage(tab.id, { type: 'deep-research:request-page' });
    return { tabId: tab.id, windowId: tab.windowId, url: tab.url };
  });
}

async function configureProvider(panel) {
  await panel.locator('#settings-button').click();
  await panel.locator('#provider-kind').selectOption('custom');
  await panel.locator('#provider-url').fill(`http://127.0.0.1:${providerPort}/v1`);
  await panel.locator('#provider-model').fill('fake-reader');
  await panel.locator('#provider-key').fill('test-key');
  await panel.locator('#request-provider-origin').uncheck();
  await panel.locator('#save-settings').click();
  await panel.locator('#settings-notice').waitFor({ state: 'visible', timeout: 10_000 });
  await panel.locator('#close-settings').click();
}

let firstContext;
let secondContext;
try {
  // Browser session 1: create a durable running task, then terminate the
  // entire browser so the MV3 worker cannot finish it in memory.
  firstContext = await launch();
  const firstWorker = firstContext.serviceWorkers()[0] || await firstContext.waitForEvent('serviceworker');
  const extensionId = new URL(firstWorker.url()).host;
  const firstFixture = await firstContext.newPage();
  await firstFixture.goto(`http://127.0.0.1:${fixturePort}/fixture.html`, { waitUntil: 'domcontentloaded' });
  const firstPanel = await firstContext.newPage();
  await firstPanel.goto(`chrome-extension://${extensionId}/sidepanel.html`, { waitUntil: 'domcontentloaded' });
  await activatePage(firstWorker, firstFixture);
  await activatePage(firstWorker, firstFixture);
  await firstPanel.locator('#page-view').waitFor({ state: 'visible', timeout: 10_000 });
  await configureProvider(firstPanel);
  await firstPanel.locator('#translate-all').click();
  const runningState = await waitFor(async () => {
    const state = await readLocalState(firstPanel);
    const job = state.jobs.find((item) => ['queued', 'running'].includes(item.status));
    return job && state.taskInputs.length ? state : null;
  }, { timeout: 15_000, label: '浏览器关闭前任务持久化' });
  const runningJob = runningState.jobs.find((item) => ['queued', 'running'].includes(item.status));
  if (!runningJob) throw new Error('没有找到浏览器关闭前的持久任务');
  await firstContext.close();
  firstContext = null;

  // Browser session 2: the new worker starts from the same profile. The page
  // is opened again with a different tab id, so recovery must not depend on
  // the stale tab id from the first browser session.
  secondContext = await launch();
  const secondWorker = secondContext.serviceWorkers()[0] || await secondContext.waitForEvent('serviceworker');
  const secondExtensionId = new URL(secondWorker.url()).host;
  if (secondExtensionId !== extensionId) throw new Error('浏览器重启后扩展 ID 不稳定');
  const secondFixture = await secondContext.newPage();
  await secondFixture.goto(`http://127.0.0.1:${fixturePort}/fixture.html`, { waitUntil: 'domcontentloaded' });
  const secondPanel = await secondContext.newPage();
  await secondPanel.goto(`chrome-extension://${secondExtensionId}/sidepanel.html`, { waitUntil: 'domcontentloaded' });
  await activatePage(secondWorker, secondFixture);
  await secondPanel.locator('#page-view').waitFor({ state: 'visible', timeout: 10_000 });
  // The first page message can race the newly created panel's React/legacy
  // controller initialization. Send the same page context once the panel is
  // definitely listening, just as a user reopening the side panel would.
  await activatePage(secondWorker, secondFixture);
  await secondPanel.waitForTimeout(500);

  try {
    await waitFor(async () => {
      const result = await secondFixture.evaluate(() => ({
        overlays: document.querySelectorAll('[data-deep-research-image-overlay]').length,
        translations: document.querySelectorAll('[data-deep-research-translation]').length,
      }));
      return result.overlays === 2 && result.translations >= 6 ? result : null;
    }, { timeout: 45_000, label: '浏览器重启后的页面结果' });
  } catch (error) {
    console.error(JSON.stringify({
      panel: (await secondPanel.locator('body').innerText().catch(() => '')).slice(-1800),
      page: await secondFixture.evaluate(() => ({
        overlays: document.querySelectorAll('[data-deep-research-image-overlay]').length,
        translations: document.querySelectorAll('[data-deep-research-translation]').length,
        body: document.body.innerText.slice(0, 600),
      })).catch(() => null),
      state: await readLocalState(secondPanel).catch(() => null),
      error: error instanceof Error ? error.message : String(error),
    }, null, 2));
    throw error;
  }

  const finalState = await waitFor(async () => {
    const state = await readLocalState(secondPanel);
    const active = state.jobs.filter((item) => ['queued', 'running'].includes(item.status));
    const completed = state.jobs.find((item) => item.id === runningJob.id && ['completed', 'completed_with_errors'].includes(item.status));
    return active.length === 0 && completed && state.taskInputs.length === 0 ? state : null;
  }, { timeout: 20_000, label: '浏览器重启后的任务收口' });

  const requestLines = await readTextFile(requestLogPath, 'utf8').catch(() => '');
  const requests = requestLines.split('\n').filter(Boolean).map((line) => JSON.parse(line));
  const visibleResult = await secondFixture.evaluate(() => ({
    overlays: document.querySelectorAll('[data-deep-research-image-overlay]').length,
    translations: document.querySelectorAll('[data-deep-research-translation]').length,
  }));
  const summary = {
    extensionId,
    firstPageUrl: runningJob.documentUrl,
    firstJobBeforeBrowserClose: { id: runningJob.id, status: runningJob.status, inputReady: runningJob.inputReady },
    finalJobs: finalState.jobs.map((item) => ({ id: item.id, status: item.status, failedItems: item.failedItems?.length || 0 })),
    taskInputsAfterRestart: finalState.taskInputs.length,
    visibleResult,
    providerRequests: requests.length,
  };
  if (visibleResult.overlays !== 2 || visibleResult.translations < 6) throw new Error(`浏览器重启恢复后的页面结果不完整：${JSON.stringify(summary)}`);
  if (finalState.taskInputs.length !== 0 || finalState.jobs.some((item) => ['queued', 'running'].includes(item.status))) throw new Error(`浏览器重启恢复后的任务未收口：${JSON.stringify(summary)}`);
  console.log(JSON.stringify(summary, null, 2));
} finally {
  await secondContext?.close().catch(() => {});
  await firstContext?.close().catch(() => {});
  provider.kill('SIGTERM');
  await new Promise((resolve) => provider.once('exit', resolve));
  await new Promise((resolve) => fixtureServer.close(resolve));
  await unlink(requestLogPath).catch(() => {});
}
