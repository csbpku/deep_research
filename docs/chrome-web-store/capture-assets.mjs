// Captures the actual production UI in an isolated profile. Demo-only host
// access is added to a temporary copy, never to the production/store archive.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { cp, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '../../apps/web/node_modules/@playwright/test/index.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, '../..');
const build = resolve(process.env.READER_STORE_BUILD_DIR || resolve(repo, 'apps/extension/.output/chrome-mv3'));
const buildManifest = JSON.parse(await readFile(resolve(build, 'manifest.json'), 'utf8'));
const tokens = JSON.parse(await readFile(resolve(repo, 'packages/design-system/src/tokens.json'), 'utf8'));
const assetsRoot = resolve(process.env.READER_STORE_ASSETS_ROOT || resolve(here, 'assets'));
await mkdir(assetsRoot, { recursive: true });
const assets = await mkdtemp(resolve(assetsRoot, `reader-${buildManifest.version}-`));
const scratch = await mkdtemp('/private/tmp/reader-store-capture-');
const articleText = {
  title: 'Reading a resilient queue',
  intro: 'A bounded queue protects memory and keeps work responsive.',
  pressure: 'Backpressure tells a producer to wait when the queue is full.',
  cancel: 'Cancellation stops stale requests before they consume more model capacity.',
  evidence: 'A good explanation should point to the exact source passage.',
};
const translations = new Map([
  [articleText.title, '读懂一个可靠的队列'],
  [articleText.intro, '有界队列限制内存占用，让工作保持响应。'],
  ['Capacity and backpressure', '容量与背压'],
  [articleText.pressure, '队列满时，背压通知生产者等待。'],
  ['Cancel stale work', '取消过期任务'],
  [articleText.cancel, '取消操作会停止过期请求，避免它们继续消耗模型容量。'],
  [articleText.evidence, '好的解释应该指向准确的原文选段。'],
]);
const answer = JSON.stringify({
  answer: '有界队列限制积压任务，避免内存无限增长。[1]',
  evidence: [{ quote: articleText.intro, claim: '有界队列保护内存并保持响应。' }],
  background: '', inference: '', limitations: ['原文未给出具体容量，需结合业务负载确定。'],
});
const articleHtml = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${articleText.title}</title><style>body{margin:0;padding:38px 42px;color:${tokens['color-text']};background:${tokens['color-surface']};font:17px/1.8 ${tokens['font-family']}}main{max-width:680px;margin:auto}.kicker{font-size:11px;color:${tokens['color-text-muted']};letter-spacing:1.5px}h1{font-size:34px;line-height:1.2;margin:16px 0 24px;letter-spacing:-1px}h2{font-size:21px;line-height:1.4;margin:28px 0 10px}p{margin:0 0 16px}aside{font-size:12px;color:${tokens['color-text-muted']};margin-top:32px;padding-top:16px;border-top:1px solid ${tokens['color-outline']}}</style></head><body><main><div class="kicker">READER · ENGINEERING NOTES</div><article><h1>${articleText.title}</h1><p id="intro">${articleText.intro}</p><h2>Capacity and backpressure</h2><p>${articleText.pressure}</p><h2>Cancel stale work</h2><p id="target">${articleText.cancel}</p><p>${articleText.evidence}</p></article><aside>演示文章 · 本页专为展示 Reader 功能编写</aside></main></body></html>`;
const requests = [];
const server = createServer(async (request, response) => {
  response.setHeader('access-control-allow-origin', '*');
  response.setHeader('access-control-allow-headers', 'content-type, authorization');
  response.setHeader('access-control-allow-methods', 'GET, POST, OPTIONS');
  if (request.method === 'OPTIONS') { response.writeHead(204); response.end(); return; }
  if (request.url === '/article') { response.setHeader('content-type', 'text/html; charset=utf-8'); response.end(articleHtml); return; }
  response.setHeader('content-type', 'application/json');
  if (request.url === '/v1/models') { response.end(JSON.stringify({ data: [{ id: 'reader-demo-model' }] })); return; }
  let body = ''; for await (const chunk of request) body += chunk;
  const input = JSON.parse(body || '{}');
  requests.push({ model: input.model, stream: Boolean(input.stream) });
  const user = String(input.messages?.at(-1)?.content || '');
  const system = String(input.messages?.[0]?.content || '');
  let content = answer;
  if (user.includes('Reply with OK')) content = 'OK';
  else if (system.includes('翻译编辑')) {
    const batch = user.split('<<<TRANSLATION_BATCH>>>\n')[1];
    assert.ok(batch, 'Expected a structured translation batch');
    content = JSON.stringify({ translations: JSON.parse(batch).blocks.map((block) => ({ id: block.id, text: translations.get(block.text.trim()) || block.text })) });
  }
  if (input.stream) {
    response.setHeader('content-type', 'text/event-stream');
    response.end(`data: ${JSON.stringify({ choices: [{ delta: { content } }] })}\n\ndata: [DONE]\n\n`);
  } else response.end(JSON.stringify({ choices: [{ message: { content } }] }));
});
await new Promise((resolveListen, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolveListen); });
const port = server.address().port;
const temporaryExtension = resolve(scratch, 'extension');
await cp(build, temporaryExtension, { recursive: true });
const manifest = JSON.parse(await readFile(resolve(temporaryExtension, 'manifest.json'), 'utf8'));
assert.deepEqual(manifest.host_permissions || [], [], 'Capture must start from the production build');
manifest.host_permissions = ['http://127.0.0.1/*'];
await writeFile(resolve(temporaryExtension, 'manifest.json'), JSON.stringify(manifest));
const executablePath = process.env.CHROME_FOR_TESTING || [
  '/Users/shaobo.chen/Library/Caches/ms-playwright/chromium-1234/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
].find(existsSync);
assert.ok(executablePath, 'Set CHROME_FOR_TESTING to an extension-capable Chromium executable');
const context = await chromium.launchPersistentContext(resolve(scratch, 'profile'), {
  executablePath, headless: true, viewport: { width: 730, height: 610 },
  args: [`--disable-extensions-except=${temporaryExtension}`, `--load-extension=${temporaryExtension}`, '--no-first-run'],
});
await mkdir(assets, { recursive: true });
const dataUrl = async (path) => `data:image/png;base64,${(await readFile(path)).toString('base64')}`;
const escape = (text) => text.replace(/[&<>"']/gu, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
async function compose(name, title, description, leftPath, rightPath) {
  const canvas = await context.newPage();
  await canvas.setViewportSize({ width: 1280, height: 800 });
  const left = await dataUrl(leftPath), right = await dataUrl(rightPath);
  await canvas.setContent(`<!doctype html><html lang="zh-CN"><meta charset="utf-8"><style>*{box-sizing:border-box}body{margin:0;padding:34px 40px;background:${tokens['color-surface-container']};color:${tokens['color-text']};font-family:${tokens['font-family']}}header{display:flex;align-items:center;justify-content:space-between;height:84px}h1{font-size:28px;margin:0 0 8px;letter-spacing:-.5px}p{font-size:14px;margin:0;color:${tokens['color-text-muted']}}.brand{font-size:16px;font-weight:650}.views{display:grid;grid-template-columns:730px 430px;gap:20px;margin-top:16px}.view{height:610px;overflow:hidden;background:${tokens['color-surface']};border:1px solid ${tokens['color-outline']};border-radius:12px}.view img{display:block;width:100%;height:100%;object-fit:cover;object-position:top}footer{font-size:11px;color:${tokens['color-text-muted']};margin-top:16px}</style><header><div><h1>${escape(title)}</h1><p>${escape(description)}</p></div><div class="brand">Deep Research Reader</div></header><div class="views"><div class="view"><img src="${left}" alt="演示文章或设置界面"></div><div class="view"><img src="${right}" alt="真实扩展 UI"></div></div><footer>实际 Reader 界面 · 演示文章与示例回答 · AI 效果取决于所选模型服务</footer></html>`);
  await canvas.locator('img').evaluateAll((images) => Promise.all(images.map((image) => image.decode())));
  await canvas.screenshot({ path: resolve(assets, name) });
  await canvas.close();
}
try {
  const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
  const extensionId = new URL(worker.url()).host;
  const article = await context.newPage();
  await article.goto(`http://127.0.0.1:${port}/article`);
  const panel = await context.newPage();
  await panel.setViewportSize({ width: 430, height: 610 });
  await panel.goto(`chrome-extension://${extensionId}/sidepanel.html`);
  await panel.waitForFunction(() => document.documentElement.dataset.readerReady === 'true');
  await article.bringToFront();
  const tabId = await worker.evaluate(async (url) => {
    const [tab] = await chrome.tabs.query({ url });
    await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['content.js'] });
    await chrome.tabs.sendMessage(tab.id, { type: 'deep-research:request-page' });
    return tab.id;
  }, article.url());
  await panel.locator('#page-view').waitFor({ state: 'visible' });
  await panel.locator('#settings-button').click();
  await panel.locator('#provider-kind').selectOption('local-proxy', { force: true });
  await panel.locator('#provider-url').fill(`http://127.0.0.1:${port}/v1`);
  await panel.locator('#provider-key').fill('');
  await panel.locator('#provider-model-list option[value="reader-demo-model"]').waitFor({ state: 'attached' });
  await panel.locator('#provider-model-list').selectOption('reader-demo-model');
  await panel.locator('#test-provider').click();
  await panel.waitForFunction(() => document.querySelector('#provider-test-status')?.textContent?.includes('连接成功'));
  await panel.locator('#save-settings').click();
  await panel.waitForFunction(() => document.querySelector('#settings-notice')?.textContent?.includes('已保存'));
  await panel.locator('#close-settings').click();
  await article.evaluate(() => {
    const node = document.querySelector('#intro'); const range = document.createRange(); range.selectNodeContents(node);
    const selection = getSelection(); selection.removeAllRanges(); selection.addRange(range); node.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
  });
  await panel.locator('#chat-selection-card').waitFor({ state: 'visible' });
  await panel.locator('#question-input').fill('有界队列为什么能保护内存？');
  await panel.locator('#send-question').click();
  await panel.locator('#reader-evidence-1').waitFor({ state: 'visible' });
  assert.ok((await panel.locator('#reader-evidence-1').textContent()).includes('在网页中定位'));
  await panel.locator('#reader-evidence-1').click();
  assert.equal(await article.locator('#intro').evaluate((node, color) => {
    const expected = document.createElement('span'); expected.style.color = color; document.body.append(expected);
    const matches = getComputedStyle(node).outlineColor === getComputedStyle(expected).color;
    expected.remove(); return matches;
  }, tokens['color-primary']), true, 'Evidence uses the shared primary-color highlight');
  await article.evaluate(() => getSelection()?.removeAllRanges());
  await article.mouse.move(0, 0);
  if (await panel.locator('#dismiss-notice').isVisible()) await panel.locator('#dismiss-notice').click();
  await panel.screenshot({ path: resolve(scratch, 'panel-selection-context.png') });
  await panel.locator('#clear-chat-selection').click();
  await panel.locator('#chat-selection-card').waitFor({ state: 'hidden' });
  await panel.locator('#chat-transcript').evaluate((node) => {
    const answer = document.querySelector('#conversation-list > article.assistant:last-child');
    node.scrollTop += answer.getBoundingClientRect().top - node.getBoundingClientRect().top - 12;
  });
  await panel.evaluate(() => document.activeElement?.blur());
  // Evidence highlighting resets after 1.8s and can trigger a new page status.
  // Allow that real status to fade as well; do not hide controls for the image.
  await article.waitForTimeout(5200);
  await article.screenshot({ path: resolve(scratch, 'article-original.png') });
  await panel.screenshot({ path: resolve(scratch, 'panel-chat.png') });
  await compose('01-chat-and-evidence.png', '围绕原文提问，让回答有据可查', '围绕选段或全文提问；点击证据，回到对应原文。', resolve(scratch, 'article-original.png'), resolve(scratch, 'panel-chat.png'));

  // Restore article ownership after composing the first image in another tab.
  await article.bringToFront();
  await worker.evaluate(async (id) => chrome.tabs.sendMessage(id, { type: 'deep-research:request-page' }), tabId);
  if (await panel.locator('#scope-page').isVisible()) await panel.locator('#scope-page').click();
  await panel.locator('#chat-translate').click();
  await article.waitForFunction(() => document.body.innerText.includes('队列满时，背压通知生产者等待。'));
  await panel.locator('#translation-summary[data-state="completed"]').waitFor({ state: 'visible' });
  const paragraphId = await article.locator('#intro').getAttribute('data-deep-research-block');
  assert.ok(paragraphId, 'Translated paragraph must retain its block ID');
  await article.evaluate((id) => {
    const node = document.querySelector(`[data-deep-research-translation-for="${id}"]`);
    node.dispatchEvent(new PointerEvent('pointerover', { bubbles: true }));
  }, paragraphId);
  const paragraphControl = article.locator('[data-deep-research-paragraph-control] button');
  await paragraphControl.filter({ hasText: '查看这一段原文' }).waitFor({ state: 'visible' });
  const callsBeforeToggle = requests.length;
  await paragraphControl.click();
  await article.locator('#intro').waitFor({ state: 'visible' });
  await paragraphControl.filter({ hasText: '查看这一段译文' }).click();
  await article.locator(`[data-deep-research-translation-for="${paragraphId}"]`).waitFor({ state: 'visible' });
  assert.equal(requests.length, callsBeforeToggle, 'Cached paragraph toggle must not start a model request');
  await article.waitForTimeout(2800);
  await article.screenshot({ path: resolve(scratch, 'article-translated.png') });
  await panel.screenshot({ path: resolve(scratch, 'panel-translated.png') });
  await compose('02-translation.png', '边读边翻译，随时回到原文', '按段显示译文；段落按钮、右键和快捷键都能双向切换。', resolve(scratch, 'article-translated.png'), resolve(scratch, 'panel-translated.png'));

  await panel.locator('#settings-button').click();
  await panel.setViewportSize({ width: 730, height: 610 });
  await panel.locator('#local-provider-settings .settings-card-heading').evaluate(node => node.scrollIntoView({ block: 'start' }));
  await panel.screenshot({ path: resolve(scratch, 'settings-top.png') });
  await panel.setViewportSize({ width: 430, height: 610 });
  await panel.locator('#settings-view').evaluate((node) => { node.scrollTop = node.scrollHeight; });
  await panel.screenshot({ path: resolve(scratch, 'settings-data.png') });
  await compose('03-model-and-data.png', '选择自己的模型，管理自己的阅读成果', '连接后自动获取模型列表；本地 API 的回环地址 Key 选填；阅读数据可导出或清除。', resolve(scratch, 'settings-top.png'), resolve(scratch, 'settings-data.png'));
  const privacy = await context.newPage();
  const privacyResponse = await privacy.goto(`chrome-extension://${extensionId}/privacy.html`);
  assert.ok(privacyResponse?.ok());
  await privacy.getByRole('heading', { name: '隐私政策', exact: true }).waitFor();
  assert.ok((await privacy.locator('body').innerText()).includes('500 条'));
  const iconPath = resolve(repo, 'apps/extension/assets/icons/icon-128.png');
  await cp(iconPath, resolve(assets, 'icon-128.png'));
  const promo = await context.newPage();
  await promo.setViewportSize({ width: 440, height: 280 });
  await promo.setContent(`<style>body{margin:0;background:${tokens['color-text']};color:${tokens['color-inverse-text']};font-family:${tokens['font-family']};display:flex;align-items:center;justify-content:center;height:280px}main{display:flex;align-items:center;gap:18px}img{width:110px;height:110px}h1{font-size:36px;margin:0;letter-spacing:-1px}p{color:${tokens['color-primary-container']};font-size:14px;margin:8px 0 0}</style><main><img src="${await dataUrl(iconPath)}"><div><h1>Reader</h1><p>阅读 · 翻译 · 对话</p></div></main>`);
  await promo.locator('img').evaluate((image) => image.decode());
  await promo.screenshot({ path: resolve(assets, 'promo-small-440x280.png') });
  const outputs = ['01-chat-and-evidence.png', '02-translation.png', '03-model-and-data.png', 'promo-small-440x280.png', 'icon-128.png'];
  const files = [];
  for (const file of outputs) {
    const bytes = await readFile(resolve(assets, file));
    const expected = file === 'icon-128.png' ? [128, 128] : file.startsWith('promo-') ? [440, 280] : [1280, 800];
    assert.deepEqual([bytes.readUInt32BE(16), bytes.readUInt32BE(20)], expected, `${file} store dimensions`);
    files.push({ file, sha256: createHash('sha256').update(bytes).digest('hex'), size: bytes.length, dimensions: expected });
  }
  const report = { version: manifest.version, extensionId, build, assets, scratch, files, screenshots: outputs.slice(0, 3), screenshotSize: [1280, 800], promoSize: [440, 280], localKeyOptional: true, modelDiscovery: true, sourceEvidenceLocated: true, paragraphToggleWithoutModelCall: true, offlinePrivacyLoaded: true, requests, demonstration: 'Deterministic local model and authored demo article. Not a live-model performance test. Extension ID and localhost permission belong only to the isolated capture copy.' };
  await writeFile(resolve(assets, 'capture-report.json'), JSON.stringify(report, null, 2)+'\n');
  console.log(JSON.stringify(report, null, 2));
} catch (error) {
  for (const page of context.pages()) if (page.url().includes('sidepanel')) {
    await page.screenshot({ path: resolve(scratch, 'failure.png') }).catch(() => {});
    console.error('Panel:', (await page.locator('body').innerText()).slice(-4500));
  }
  console.error('Capture scratch:', scratch, 'Assets:', assets);
  throw error;
} finally { await context.close(); server.closeAllConnections(); await new Promise((close) => server.close(close)); }
