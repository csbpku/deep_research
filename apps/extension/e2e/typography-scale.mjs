import { cp, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { chromium } from '../../web/node_modules/@playwright/test/index.mjs';
import { tempPath } from './temp-paths.mjs';
import assert from 'node:assert/strict';

// Reading size is a panel-only preference: the answer body must follow the
// stored scale, the default must keep the original 15px/1.8, and switching
// must take effect without a reload.
const extensionPath = `${await mkdtemp(tempPath('reader-type-scale-extension-'))}/extension`;
await cp(new URL('../.output/chrome-mv3', import.meta.url), extensionPath, { recursive: true });
const manifestPath = `${extensionPath}/manifest.json`;
const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
manifest.host_permissions = [...new Set([...(manifest.host_permissions || []), 'http://127.0.0.1/*'])];
await writeFile(manifestPath, JSON.stringify(manifest));

const executablePath = process.env.CHROME_FOR_TESTING || [
  '/Users/shaobo.chen/Library/Caches/ms-playwright/chromium-1234/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
].find(existsSync);

const context = await chromium.launchPersistentContext(tempPath(`reader-type-scale-profile-${Date.now()}`), {
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

try {
  const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
  const extensionId = new URL(worker.url()).host;
  await worker.evaluate(() => chrome.storage.local.set({ readerUiLanguage: 'zh-CN' }));

  const panel = await context.newPage();
  await panel.goto(`chrome-extension://${extensionId}/sidepanel.html`, { waitUntil: 'domcontentloaded' });
  await panel.waitForFunction(() => document.documentElement.dataset.readerReady === 'true');

  // Render a real markdown paragraph through the panel stylesheet.
  await panel.evaluate(() => {
    const host = document.querySelector('#answer-output');
    const paragraph = document.createElement('p');
    paragraph.className = 'reader-markdown-paragraph';
    paragraph.id = 'type-scale-probe';
    paragraph.textContent = 'Bounded queues keep browser work responsive.';
    host.appendChild(paragraph);
  });
  const readSize = () => panel.evaluate(() => {
    const paragraph = document.querySelector('#type-scale-probe');
    const style = getComputedStyle(paragraph);
    return {
      scale: document.documentElement.dataset.readerTypeScale || '',
      size: style.fontSize,
      leading: style.lineHeight,
      variable: getComputedStyle(document.documentElement).getPropertyValue('--reader-reading-size').trim(),
    };
  });

  // 1. Default stays at the original reading size.
  const comfortable = await readSize();
  assert.equal(comfortable.scale, 'comfortable', `默认应为舒适档：${JSON.stringify(comfortable)}`);
  assert.equal(comfortable.size, '15px', `默认正文应保持 15px：${JSON.stringify(comfortable)}`);
  assert.equal(comfortable.variable, '15px');

  // 2. A stored compact scale applies without a reload.
  await panel.evaluate(async () => chrome.storage.local.set({ readerTypeScale: 'compact' }));
  await panel.waitForFunction(() => document.documentElement.dataset.readerTypeScale === 'compact', null, { timeout: 10_000 });
  const compact = await readSize();
  assert.equal(compact.size, '14px', `紧凑档应为 14px：${JSON.stringify(compact)}`);
  assert.ok(parseFloat(compact.leading) < parseFloat(comfortable.leading), `紧凑档行高应更紧：${compact.leading} vs ${comfortable.leading}`);

  // 3. Large grows the body and the leading.
  await panel.evaluate(async () => chrome.storage.local.set({ readerTypeScale: 'large' }));
  await panel.waitForFunction(() => document.documentElement.dataset.readerTypeScale === 'large', null, { timeout: 10_000 });
  const large = await readSize();
  assert.equal(large.size, '17px', `大档应为 17px：${JSON.stringify(large)}`);
  assert.ok(parseFloat(large.leading) > parseFloat(compact.leading), `大档行高应更宽：${large.leading} vs ${compact.leading}`);

  // 4. Unknown values fall back to the default instead of breaking layout.
  await panel.evaluate(async () => chrome.storage.local.set({ readerTypeScale: 'gigantic' }));
  await panel.waitForFunction(() => document.documentElement.dataset.readerTypeScale === 'comfortable', null, { timeout: 10_000 });
  assert.equal((await readSize()).size, '15px', '非法值应回到舒适档');

  console.log(JSON.stringify({
    ok: true,
    checks: [
      'the default scale keeps the original 15px body',
      'compact applies 14px and a tighter leading without a reload',
      'large applies 17px and a wider leading',
      'an unknown stored value falls back to comfortable',
    ],
    sizes: { compact: compact.size, comfortable: comfortable.size, large: large.size },
  }, null, 2));
} finally {
  await context.close();
}
