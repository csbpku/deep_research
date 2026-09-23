import { existsSync } from 'node:fs';
import { chromium } from '../../../apps/web/node_modules/@playwright/test/index.mjs';

const baseUrl = (process.env.READER_PLATFORM_URL || 'http://localhost:3000').replace(/\/$/u, '');
const response = await fetch(`${baseUrl}/api/radar?limit=20`);
if (!response.ok) throw new Error(`雷达 API 不可用: ${response.status}`);
const payload = await response.json();
const item = Array.isArray(payload.items)
  ? payload.items.find((candidate) => /^https?:\/\//u.test(String(candidate.url || '')))
  : null;
if (!item?.id || !item.url) throw new Error('雷达列表没有可打开原文的真实条目');

const extensionPath = new URL('../.output/chrome-mv3', import.meta.url).pathname;
const executablePath = process.env.CHROME_FOR_TESTING
  || [
    '/Users/shaobo.chen/Library/Caches/ms-playwright/chromium-1234/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  ].find(existsSync);
if (!executablePath) throw new Error('找不到 Chrome for Testing，请设置 CHROME_FOR_TESTING');

async function seedProvider(page) {
  await page.evaluate(async () => {
    const database = await new Promise((resolve, reject) => {
      const request = indexedDB.open('deep-research-reader', 4);
      request.onupgradeneeded = () => {
        const db = request.result;
        ['sessions', 'insights', 'annotations', 'settings', 'cache', 'jobs', 'taskInputs']
          .forEach((name) => { if (!db.objectStoreNames.contains(name)) db.createObjectStore(name, { keyPath: 'id' }); });
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    await new Promise((resolve, reject) => {
      const transaction = database.transaction('settings', 'readwrite');
      transaction.objectStore('settings').put({
        id: 'provider',
        value: {
          providerKind: 'custom',
          baseUrl: 'http://127.0.0.1:65535/v1',
          model: 'reader-e2e-placeholder',
          apiKey: 'reader-e2e-placeholder',
          language: 'zh-CN',
        },
        updatedAt: new Date().toISOString(),
      });
      transaction.oncomplete = resolve;
      transaction.onerror = () => reject(transaction.error);
    });
    database.close();
  });
}

const context = await chromium.launchPersistentContext(`/private/tmp/deep-research-reader-radar-${Date.now()}`, {
  executablePath,
  headless: process.env.READER_HEADLESS === '1',
  viewport: { width: 1360, height: 900 },
  args: [
    '--enable-extensions',
    `--disable-extensions-except=${extensionPath}`,
    `--load-extension=${extensionPath}`,
    '--no-first-run',
    '--no-default-browser-check',
  ],
});

try {
  const serviceWorker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
  const extensionId = new URL(serviceWorker.url()).host;
  const radar = await context.newPage();
  const radarUrl = `${baseUrl}/radar/${encodeURIComponent(item.id)}`;
  await radar.goto(radarUrl, { waitUntil: 'domcontentloaded' });
  const openSourceButton = radar.getByRole('button', { name: /打开原文|打开 GitHub/u });
  await openSourceButton.waitFor({ state: 'visible', timeout: 20_000 });

  await openSourceButton.click();
  await radar.getByRole('dialog').waitFor({ state: 'visible', timeout: 5_000 });
  const promptText = await radar.getByRole('dialog').innerText();
  if (!promptText.includes('先确认你已安装 Reader')) throw new Error(`安装提示文案不完整: ${promptText}`);

  await radar.getByRole('link', { name: '先安装 Reader' }).click();
  await radar.waitForURL('**/reading/install', { timeout: 10_000 });
  const installText = await radar.locator('body').innerText();
  if (!installText.includes('Beta 安装包')) throw new Error('安装页未打开');

  await radar.goto(radarUrl, { waitUntil: 'domcontentloaded' });
  await radar.getByRole('button', { name: /打开原文|打开 GitHub/u }).click();
  const sourcePromise = context.waitForEvent('page');
  await radar.getByRole('dialog').getByRole('button', { name: '我已安装，继续打开' }).click();
  const source = await sourcePromise;
  await source.waitForLoadState('domcontentloaded', { timeout: 30_000 }).catch(() => {});
  if (!source.url().includes('deep-research-source=radar')) {
    throw new Error(`原文 URL 没有保留雷达上下文: ${source.url()}`);
  }

  const panel = await context.newPage();
  await panel.goto(`chrome-extension://${extensionId}/sidepanel.html`, { waitUntil: 'domcontentloaded' });
  await panel.waitForFunction(() => document.documentElement.dataset.readerReady === 'true', null, { timeout: 15_000 });
  await seedProvider(panel);
  await panel.reload({ waitUntil: 'domcontentloaded' });
  await panel.waitForFunction(() => document.documentElement.dataset.readerReady === 'true', null, { timeout: 15_000 });

  const sourceTabId = await serviceWorker.evaluate(async (sourceUrl) => {
    const tabs = await chrome.tabs.query({});
    const tab = tabs.find((candidate) => candidate.url === sourceUrl);
    if (!tab?.id) throw new Error(`找不到原文 tab: ${sourceUrl}`);
    await chrome.runtime.sendMessage({
      type: 'deep-research:page-activation-needed',
      tabId: tab.id,
      windowId: tab.windowId,
      url: tab.url,
      reason: 'permission',
    });
    return tab.id;
  }, source.url());

  await panel.getByRole('button', { name: '启用此站点' }).click();
  await panel.waitForTimeout(500);
  const clickState = await panel.evaluate(async () => ({
    buttonText: document.querySelector('#empty-settings')?.textContent || '',
    notice: document.querySelector('#notice')?.textContent || '',
    permission: await chrome.permissions.contains({ origins: ['https://github.com/*'] }).catch(() => false),
  }));
  try {
    await panel.waitForFunction(() => document.querySelector('#page-context-status')?.textContent === '正文已读取', null, { timeout: 30_000 });
  } catch (error) {
    const diagnostic = await panel.evaluate(async () => ({
      body: document.body.innerText.slice(-1600),
      status: document.querySelector('#page-context-status')?.textContent || '',
      meta: document.querySelector('#page-context-meta')?.textContent || '',
      notice: document.querySelector('#notice')?.textContent || '',
      activation: document.body.innerText.includes('启用此站点'),
    }));
    let sourceDiagnostic;
    try {
      sourceDiagnostic = await source.evaluate(() => ({
        url: location.href,
        title: document.title,
        contentScript: Boolean(document.querySelector('[data-deep-research-dock]')),
        bodyChars: document.body.innerText.length,
      }));
    } catch (diagnosticError) {
      sourceDiagnostic = { error: String(diagnosticError) };
    }
    throw new Error(`启用站点后没有读取正文: ${JSON.stringify({ sourceTabId, clickState, diagnostic, sourceDiagnostic })}; ${error.message}`);
  }
  const state = await panel.evaluate(() => ({
    sourceTabId: Number(document.querySelector('#page-source')?.textContent ? 1 : 0),
    title: document.querySelector('#page-title')?.textContent || '',
    status: document.querySelector('#page-context-status')?.textContent || '',
    coverage: document.querySelector('#page-context-meta')?.textContent || '',
    composer: Boolean(document.querySelector('#persistent-composer') && !document.querySelector('#persistent-composer').classList.contains('hidden')),
    radarNotice: document.body.innerText.includes('来自 Deep Research 雷达'),
  }));
  if (!state.composer || state.status !== '正文已读取') throw new Error(`启用后 Reader 状态不完整: ${JSON.stringify(state)}`);

  await source.bringToFront();
  const dockState = await source.evaluate(() => {
    const dock = document.querySelector('[data-deep-research-dock]');
    return {
      present: Boolean(dock),
      rightGap: dock ? innerWidth - dock.getBoundingClientRect().right : null,
      statusToastHost: Boolean(document.querySelector('[data-deep-research-status]')),
    };
  });
  if (!dockState.present || dockState.rightGap < 0) throw new Error(`原文页右侧入口不可见: ${JSON.stringify(dockState)}`);

  console.log(JSON.stringify({
    ok: true,
    radarId: item.id,
    radarTitle: item.title,
    sourceUrl: source.url(),
    extensionId,
    sourceTabId,
    installPrompt: true,
    installPage: true,
    originalOpened: true,
    enabled: state,
    dock: dockState,
  }, null, 2));
} finally {
  await context.close();
}
