import { existsSync } from 'node:fs';
import { chromium } from '../../web/node_modules/@playwright/test/index.mjs';

const contentScript = new URL('../content.js', import.meta.url).pathname;
const executablePath = process.env.CHROME_FOR_TESTING
  || [
    '/Users/shaobo.chen/Library/Caches/ms-playwright/chromium-1234/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  ].find(existsSync);
if (!executablePath) throw new Error('找不到 Chrome，请设置 CHROME_FOR_TESTING');

const browser = await chromium.launch({ executablePath, headless: true });
const page = await browser.newPage({ viewport: { width: 1200, height: 900 } });
page.on('pageerror', (error) => console.error(`pageerror: ${error.message}`));
page.on('console', (message) => console.error(`console.${message.type()}: ${message.text()}`));
await page.addInitScript(() => {
  window.__readerMessages = [];
  const runtime = {
    sendMessage(message) { window.__readerMessages.push(message); return Promise.resolve(); },
    onMessage: { addListener(handler) { window.__readerMessageHandler = handler; } },
  };
  Object.defineProperty(window.chrome, 'runtime', { value: runtime, configurable: true });
});

// The image is deliberately local and deterministic. It gives the renderer a
// narrow/tall axis label, a horizontal legend label, and one deliberately
// unsafe long label that must remain outside the source pixels.
const svg = `<?xml version="1.0" encoding="UTF-8"?><svg xmlns="http://www.w3.org/2000/svg" width="640" height="400" viewBox="0 0 640 400"><rect width="640" height="400" fill="#f4f5f7"/><line x1="70" y1="40" x2="70" y2="340" stroke="#555"/><line x1="70" y1="340" x2="580" y2="340" stroke="#555"/><text x="8" y="250" font-size="18" transform="rotate(-90 8 250)">Completion Time (ms)</text><text x="220" y="378" font-size="18">Competing Clients</text><text x="405" y="55" font-size="18">Backoff Algorithm</text><polyline points="80,300 220,250 360,160 540,80" fill="none" stroke="#09a" stroke-width="4"/></svg>`;
const imageUrl = `data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`;
await page.setContent(`<article><h1>Chart fixture</h1><img id="chart" src="${imageUrl}" width="640" height="400" alt="chart" /></article>`);
await page.waitForTimeout(100);
await page.evaluate(() => {
  window.__readerMessages = [];
  const runtime = {
    sendMessage(message) { window.__readerMessages.push(message); return Promise.resolve(); },
    onMessage: { addListener(handler) { window.__readerMessageHandler = handler; } },
  };
  try {
    Object.defineProperty(window, 'chrome', { value: { runtime }, configurable: true, writable: true });
  } catch {
    Object.defineProperty(window.chrome, 'runtime', { value: runtime, configurable: true });
  }
});
await page.addScriptTag({ path: contentScript });
await page.evaluate(() => window.__readerMessageHandler({ type: 'deep-research:request-page' }));
try {
  await page.waitForFunction(() => document.querySelector('[data-deep-research-image]'), null, { timeout: 10_000 });
} catch (error) {
  console.error('fixture state:', await page.evaluate(() => ({ body: document.body.innerHTML, chrome: typeof window.chrome, messages: window.__readerMessages })));
  throw error;
}
const imageId = await page.locator('[data-deep-research-image]').getAttribute('data-deep-research-image');
await page.evaluate((message) => window.__readerMessageHandler(message), {
  type: 'deep-research:apply-image-translations',
  translations: [{
    id: imageId,
    confidence: 0.98,
    regions: [
      { text: 'Completion Time (ms)', translation: '完成时间（毫秒）', x: 8, y: 80, width: 22, height: 180 },
      { text: 'Competing Clients', translation: '竞争客户端数', x: 220, y: 360, width: 160, height: 22 },
      { text: 'Backoff Algorithm', translation: '退避算法', x: 405, y: 40, width: 150, height: 22 },
    ],
    fallbackRegions: [{ text: 'A very long label', translation: '一段无法安全放入原位的长说明', x: 80, y: 100, width: 100, height: 18 }],
    fallbackText: '',
  }],
});
await page.waitForTimeout(100);
const state = await page.evaluate(() => {
  const image = document.querySelector('[data-deep-research-image-wrap] img');
  const source = image?.getBoundingClientRect();
  const overlays = [...document.querySelectorAll('[data-deep-research-image-overlay] > span')];
  const side = [...document.querySelectorAll('[data-deep-research-image-side-translation]')];
  return {
    overlays: overlays.length,
    verticalWriting: overlays.some((node) => node.style.writingMode === 'vertical-rl'),
    side: side.map((node) => ({ text: node.textContent, outside: (() => { const rect = node.getBoundingClientRect(); return Boolean(source && (rect.left >= source.right || rect.right <= source.left || rect.top >= source.bottom || rect.bottom <= source.top)); })() })),
  };
});
await page.screenshot({ path: '/private/tmp/deep-research-reader-image-position.png', fullPage: true });
console.log(JSON.stringify(state, null, 2));
await browser.close();
