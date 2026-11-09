import { cp, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { chromium } from '../../web/node_modules/@playwright/test/index.mjs';
import { tempPath } from './temp-paths.mjs';
import assert from 'node:assert/strict';

// First-run contract: a user without any API key can reach a configured model
// from the empty state alone. The loopback services are intercepted, so this
// test never depends on a real Ollama or LM Studio install.
const extensionPath = `${await mkdtemp(tempPath('reader-first-run-'))}/extension`;
await cp(new URL('../.output/chrome-mv3', import.meta.url), extensionPath, { recursive: true });
const manifestPath = `${extensionPath}/manifest.json`;
const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
manifest.host_permissions = [...new Set([...(manifest.host_permissions || []), 'http://127.0.0.1/*'])];
await writeFile(manifestPath, JSON.stringify(manifest));

const executablePath = process.env.CHROME_FOR_TESTING || [
  '/Users/shaobo.chen/Library/Caches/ms-playwright/chromium-1234/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
].find(existsSync);
if (!executablePath) throw new Error('找不到 Chrome，请设置 CHROME_FOR_TESTING');

const context = await chromium.launchPersistentContext(tempPath(`reader-first-run-profile-${Date.now()}`), {
  executablePath,
  headless: process.env.READER_HEADLESS === '1',
  viewport: { width: 400, height: 900 },
  args: [
    '--enable-extensions',
    `--disable-extensions-except=${extensionPath}`,
    `--load-extension=${extensionPath}`,
    '--no-first-run',
    '--no-default-browser-check',
  ],
});

let ollamaRequests = 0;
await context.route('http://127.0.0.1:11434/**', async (route) => {
  ollamaRequests += 1;
  await route.fulfill({
    status: 200,
    contentType: 'application/json',
    headers: { 'access-control-allow-origin': '*' },
    body: JSON.stringify({ data: [{ id: 'nomic-embed-text' }, { id: 'qwen2.5-coder:7b' }] }),
  });
});

try {
  const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
  const extensionId = new URL(worker.url()).host;
  await worker.evaluate(() => chrome.storage.local.set({ readerUiLanguage: 'zh-CN' }));

  const panel = await context.newPage();
  await panel.goto(`chrome-extension://${extensionId}/sidepanel.html`, { waitUntil: 'domcontentloaded' });
  await panel.waitForFunction(() => document.documentElement.dataset.readerReady === 'true');

  await panel.locator('#first-run-paths').waitFor({ state: 'visible', timeout: 10_000 });
  assert.equal(await panel.locator('#empty-history').isVisible(), false, '首次安装不应显示空的聊天记录入口');
  assert.match(await panel.locator('#empty-description').innerText(), /不自带模型/);
  assert.equal(await panel.locator('#local-models-result').isVisible(), false, '未检测前不应显示结果区');

  // The first-run block replaces the old one-line empty state, so it has to
  // hold up at the narrowest supported panel width.
  await panel.setViewportSize({ width: 320, height: 820 });
  const narrow = await panel.evaluate(() => {
    const visible = (element) => {
      const style = getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      return style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 0 && rect.height > 0;
    };
    const clipped = [...document.querySelectorAll('#empty-view button')].filter(visible).flatMap((element) => {
      const rect = element.getBoundingClientRect();
      return rect.left < -0.5 || rect.right > innerWidth + 0.5 || element.scrollWidth > element.clientWidth + 1
        ? [{ id: element.id || element.textContent.trim(), left: rect.left, right: rect.right }]
        : [];
    });
    return {
      overflowX: document.documentElement.scrollWidth > innerWidth + 1,
      clipped,
      primaryInViewport: document.querySelector('#empty-settings').getBoundingClientRect().bottom <= innerHeight,
    };
  });
  assert.equal(narrow.overflowX, false, `首次运行在 320px 出现横向溢出：${JSON.stringify(narrow)}`);
  assert.deepEqual(narrow.clipped, [], `首次运行按钮文字被裁切：${JSON.stringify(narrow.clipped)}`);
  assert.equal(narrow.primaryInViewport, true, '320px 下主操作应在首屏内');
  await panel.setViewportSize({ width: 400, height: 900 });

  await panel.locator('#detect-local-models').click();
  const ollama = panel.locator('[data-local-model="ollama"]');
  await ollama.waitFor({ state: 'visible', timeout: 10_000 });
  assert.ok(ollamaRequests > 0, '检测应该请求本机 /models');
  const ollamaText = await ollama.innerText();
  assert.match(ollamaText, /Ollama/);
  assert.match(ollamaText, /2 个模型/);
  assert.match(ollamaText, /qwen2\.5-coder:7b/, '默认模型应跳过 embedding 模型');
  assert.equal(await panel.locator('[data-local-model="lm-studio"]').count(), 0, '未运行的服务不应出现在结果里');

  await ollama.click();
  await panel.waitForFunction(() => document.querySelector('#first-run-paths')?.classList.contains('hidden'), null, { timeout: 10_000 });
  await panel.waitForFunction(() => document.querySelector('#notice')?.textContent?.includes('Ollama'), null, { timeout: 10_000 });

  const configured = await panel.evaluate(async () => {
    const database = await new Promise((resolve, reject) => {
      const request = indexedDB.open('deep-research-reader', 4);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    const value = await new Promise((resolve, reject) => {
      const store = database.transaction('settings', 'readonly').objectStore('settings').get('provider');
      store.onsuccess = () => resolve(store.result?.value || null);
      store.onerror = () => reject(store.error);
    });
    database.close();
    return value;
  });
  assert.equal(configured?.baseUrl, 'http://127.0.0.1:11434/v1');
  assert.equal(configured?.model, 'qwen2.5-coder:7b');
  assert.equal(configured?.providerKind, 'ollama');
  assert.equal(configured?.apiKey, '');

  await panel.reload({ waitUntil: 'domcontentloaded' });
  await panel.waitForFunction(() => document.documentElement.dataset.readerReady === 'true');
  await panel.waitForFunction(() => document.querySelector('#first-run-paths')?.classList.contains('hidden'), null, { timeout: 10_000 });
  assert.match(await panel.locator('#status-text').innerText(), /qwen2\.5-coder:7b/);

  console.log(JSON.stringify({
    ok: true,
    checks: [
      'first run shows the local option, the provider option and hides empty history',
      '320px first run keeps the primary action in view without clipping',
      'detection probes loopback /models and reports reachable services with a chat default',
      'one click saves the local provider without an API key and leaves first-run state',
      'the saved provider survives a panel reload',
    ],
    ollamaRequests,
    model: configured.model,
  }, null, 2));
} finally {
  await context.close();
}
