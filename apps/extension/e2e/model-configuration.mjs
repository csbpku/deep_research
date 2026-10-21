import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { cp, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { chromium } from '../../web/node_modules/@playwright/test/index.mjs';

const artifacts = await mkdtemp('/private/tmp/reader-model-configuration-');
const build = new URL('../.output/chrome-mv3/', import.meta.url).pathname;
const requests = [];
let chatCalls = 0;
const inventory = Array.from({ length: 12 }, (_, i) => ({ id: `chat-${String(i).padStart(2, '0')}` }));
const server = createServer(async (request, response) => {
  requests.push(request.url);
  response.setHeader('content-type', 'application/json');
  if (request.url.startsWith('/unauthorized/')) { response.writeHead(401); response.end('{}'); return; }
  if (request.url.startsWith('/unsupported/') && request.url.endsWith('/models')) { response.writeHead(404); response.end('{}'); return; }
  if (request.url.startsWith('/empty/')) { response.end('{"data":[]}'); return; }
  if (request.url.startsWith('/html/')) { response.end('<html>Not an API</html>'); return; }
  if (request.url.startsWith('/timeout/')) return;
  if (request.url.startsWith('/slow/')) {
    setTimeout(() => { if (!response.destroyed) response.end('{"data":[{"id":"stale-model"}]}'); }, 900);
    return;
  }
  if (request.url.startsWith('/fast/')) { response.end('{"data":[{"id":"current-model"}]}'); return; }
  if (request.url.endsWith('/models')) { response.end(JSON.stringify({ data: inventory })); return; }
  if (request.url.endsWith('/chat/completions')) {
    let raw = '';
    for await (const chunk of request) raw += chunk;
    const input = JSON.parse(raw);
    assert.ok(input.model);
    chatCalls += 1;
    response.end('{"choices":[{"message":{"content":"OK"}}]}');
    return;
  }
  response.writeHead(404); response.end('{}');
});
await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
const port = server.address().port;
const executablePath = process.env.CHROME_FOR_TESTING
  || '/Users/shaobo.chen/Library/Caches/ms-playwright/chromium-1234/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing';
const contexts = [];
const checks = [];
async function launch(path, name) {
  const context = await chromium.launchPersistentContext(`${artifacts}/${name}-profile`, {
    executablePath, headless: true, viewport: { width: 430, height: 820 },
    args: [`--disable-extensions-except=${path}`, `--load-extension=${path}`, '--no-first-run'],
  });
  contexts.push(context);
  const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
  const id = new URL(worker.url()).host;
  const page = await context.newPage();
  await page.goto(`chrome-extension://${id}/sidepanel.html`);
  await page.waitForFunction(() => document.documentElement.dataset.readerReady === 'true');
  await page.locator('#settings-button').click();
  return page;
}
async function status(page, state) {
  await page.waitForFunction(s => document.querySelector('#model-discovery-status')?.dataset.state === s, state, { timeout: 12000 });
}
async function configure(page, path = '', key = '') {
  await page.locator('#provider-kind').selectOption('local-proxy', { force: true });
  await page.locator('#provider-url').fill(`http://127.0.0.1:${port}${path}/v1`);
  await page.locator('#provider-key').fill(key);
}
try {
  // Start from the untouched production manifest: auto-discovery must never
  // bypass the user's optional host permission, unlike a pregranted fixture.
  const production = await launch(build, 'production');
  assert.deepEqual(JSON.parse(await readFile(`${build}/manifest.json`, 'utf8')).host_permissions || [], []);
  await production.locator('#provider-picker-trigger').click();
  await production.getByRole('dialog', { name: '选择模型服务商' }).waitFor();
  assert.equal(await production.locator('#provider-picker-search').evaluate(n => n === document.activeElement), true);
  assert.equal(await production.locator('[data-provider-id]').count(), 19);
  await production.locator('#provider-picker-search').fill('Google');
  await production.locator('[data-provider-id="gemini"]').click();
  assert.equal(await production.locator('#provider-kind').inputValue(), 'gemini');
  assert.equal(await production.locator('#provider-picker-label').innerText(), 'Google Gemini');
  assert.match(await production.locator('#provider-url').inputValue(), /generativelanguage/u);
  await production.locator('#provider-picker-trigger').click();
  await production.locator('#provider-picker-search').fill('本机');
  assert.equal(await production.locator('[data-provider-id]:visible').count(), 3);
  await production.keyboard.press('Escape');
  assert.equal(await production.locator('#provider-picker-trigger').getAttribute('aria-expanded'), 'false');
  assert.equal(await production.locator('#provider-picker-trigger').evaluate(n => n === document.activeElement), true);
  await production.locator('#provider-picker-trigger').click();
  await production.locator('#provider-picker-search').fill('OpenAI');
  await production.locator('[data-provider-id="openai"]').click();
  await production.waitForFunction(() => document.querySelector('#provider-picker-icon')?.complete && document.querySelector('#provider-picker-icon')?.naturalWidth > 0);
  checks.push('real provider picker loads brand icons, searches grouped options and supports Escape/focus return');
  await production.locator('#refresh-models').click();
  await status(production, 'error');
  assert.match(await production.locator('#model-discovery-status').innerText(), /API Key/);
  assert.equal(await production.locator('#provider-key').evaluate(n => n === document.activeElement), true);
  checks.push('missing Key gives a focused field error');
  await production.locator('#provider-url').fill('');
  await production.locator('#refresh-models').click();
  await status(production, 'error');
  assert.equal(await production.locator('#provider-url').evaluate(n => n === document.activeElement), true);
  assert.match(await production.locator('#model-discovery-status').innerText(), /API 地址/);
  checks.push('an empty API address is validated instead of silently using a different endpoint');
  await configure(production);
  await production.waitForTimeout(700);
  assert.equal(requests.length, 0);
  assert.match(await production.locator('#model-discovery-status').innerText(), /等待连接/);
  checks.push('production auto-discovery sends no request without origin permission');

  // Other provider behavior uses only this temporary fixture permission.
  // The production/test delivery archives are never changed by the harness.
  const fixture = `${artifacts}/extension`;
  await cp(build, fixture, { recursive: true });
  const manifest = JSON.parse(await readFile(`${fixture}/manifest.json`, 'utf8'));
  manifest.host_permissions = ['http://127.0.0.1/*'];
  await writeFile(`${fixture}/manifest.json`, JSON.stringify(manifest));
  const page = await launch(fixture, 'fixture');
  await configure(page);
  await page.locator('#provider-url').fill(`http://127.0.0.1:${port}/v1/chat/completions`);
  await status(page, 'ready');
  assert.match(await page.locator('#model-discovery-status').innerText(), /12/);
  assert.equal(await page.locator('#provider-model-list').inputValue(), '');
  await page.locator('#provider-model-search').fill('chat-11');
  await page.locator('#provider-model-list').selectOption('chat-11');
  checks.push('full completion URL normalizes; models are searchable and not silently selected');
  await page.locator('#save-settings').click();
  await page.waitForFunction(() => document.querySelector('#settings-notice')?.innerText.includes('已保存'));
  assert.equal(chatCalls, 0);
  assert.equal(await page.locator('#provider-url').inputValue(), `http://127.0.0.1:${port}/v1`);
  checks.push('saving normalized settings performs no model inference');
  await page.locator('#test-provider').click();
  await page.waitForFunction(() => document.querySelector('#provider-test-status')?.dataset.state === 'verified');
  assert.equal(chatCalls, 1);
  checks.push('explicit connection test receives a model reply');

  await page.locator('#provider-kind').selectOption('custom', { force: true });
  assert.equal(await page.locator('#provider-connection-state').innerText(), '未连接');
  await page.locator('#provider-url').fill('https://custom.example/v1');
  await page.locator('#provider-key').fill('fixture-only-key');
  await page.locator('#provider-kind').selectOption('anthropic', { force: true });
  assert.equal(await page.locator('#provider-key').inputValue(), '');
  await page.locator('#provider-kind').selectOption('custom', { force: true });
  assert.equal(await page.locator('#provider-key').inputValue(), 'fixture-only-key');
  assert.equal(await page.locator('#provider-url').inputValue(), 'https://custom.example/v1');
  await page.locator('#close-settings').click();
  await page.locator('#settings-button').click();
  assert.equal(await page.locator('#provider-url').inputValue(), 'https://custom.example/v1');
  checks.push('drafts survive navigation and provider switching without sending keys to another provider');
  await page.locator('#provider-key-toggle').click();
  assert.equal(await page.locator('#provider-key').getAttribute('type'), 'text');
  await page.locator('#close-settings').click();
  await page.locator('#settings-button').click();
  assert.equal(await page.locator('#provider-key').getAttribute('type'), 'password');
  checks.push('Key visibility is explicit and resets when settings close');

  await configure(page, '/unauthorized', 'wrong-fixture-key');
  await status(page, 'error');
  assert.match(await page.locator('#model-discovery-status').innerText(), /认证|Key/);
  assert.equal(await page.locator('#manual-model-settings').getAttribute('open'), null);
  checks.push('authentication failure does not suggest bypassing it with a model ID');
  await configure(page, '/unsupported');
  await status(page, 'error');
  assert.equal(await page.locator('#manual-model-settings').evaluate(n => n.open), true);
  await page.locator('#provider-model').fill('manual-chat');
  const callsBeforeSave = chatCalls;
  await page.locator('#save-settings').click();
  await page.waitForFunction(() => document.querySelector('#provider-model-list')?.value === 'manual-chat');
  assert.equal(chatCalls, callsBeforeSave);
  await page.locator('#test-provider').click();
  await page.waitForFunction(() => document.querySelector('#provider-test-status')?.dataset.state === 'verified');
  checks.push('a service without /models remains usable through an explicit model ID');
  await configure(page, '/html');
  await status(page, 'error');
  assert.match(await page.locator('#model-discovery-status').innerText(), /API|地址/);
  checks.push('an HTML endpoint gives an address error');
  await configure(page, '/slow');
  await page.waitForFunction(() => document.querySelector('#model-discovery-status')?.dataset.state === 'loading');
  await configure(page, '/fast');
  await status(page, 'ready');
  await page.waitForTimeout(1000);
  assert.equal(await page.locator('#provider-model-list option[value="stale-model"]').count(), 0);
  assert.equal(await page.locator('#provider-model-list option[value="current-model"]').count(), 1);
  checks.push('a late response from a previous address cannot replace current models');
  await configure(page, '/timeout');
  await status(page, 'error');
  assert.match(await page.locator('#model-discovery-status').innerText(), /超时/);
  assert.equal(await page.locator('#refresh-models').isEnabled(), true);
  checks.push('a timeout leaves a retryable connection control');

  await configure(page);
  await status(page, 'ready');
  for (const width of [320, 360, 430]) {
    await page.setViewportSize({ width, height: 820 });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    const overflow = await page.locator('#local-provider-settings').evaluate(root => [...root.querySelectorAll('button,input,select')].filter(n => n.getBoundingClientRect().width > 0).filter(n => n.getBoundingClientRect().right > innerWidth + 1 || n.getBoundingClientRect().left < 0).map(n => n.id));
    assert.deepEqual(overflow, []);
    await page.screenshot({ path: `${artifacts}/settings-${width}.png` });
    await page.locator('#provider-picker-trigger').click();
    const bounds = await page.locator('#provider-picker-menu').boundingBox();
    assert.ok(bounds.x >= 0 && bounds.x + bounds.width <= width + 1 && bounds.y >= 0 && bounds.y + bounds.height <= 821);
    await page.waitForFunction(() => {
      const bounds = document.querySelector('#provider-picker-options').getBoundingClientRect();
      return [...document.querySelectorAll('#provider-picker-options img')].filter(n => {
        const r = n.getBoundingClientRect();
        return r.top >= bounds.top && r.bottom <= bounds.bottom;
      }).every(n => n.complete && n.naturalWidth > 0);
    });
    await page.screenshot({ path: `${artifacts}/provider-picker-${width}.png` });
    await page.keyboard.press('Escape');
  }
  checks.push('320/360/430px settings have no horizontal overflow or clipped controls');
  await page.setViewportSize({ width: 360, height: 560 });
  await page.locator('#provider-picker-trigger').click();
  await page.locator('#provider-picker-search').fill('Gemini');
  const menuBounds = await page.locator('#provider-picker-menu').boundingBox();
  const triggerBounds = await page.locator('#provider-picker-trigger').boundingBox();
  assert.ok(menuBounds.y >= 0 && menuBounds.y + menuBounds.height <= 560);
  const gap = menuBounds.y >= triggerBounds.y + triggerBounds.height
    ? menuBounds.y - triggerBounds.y - triggerBounds.height
    : triggerBounds.y - menuBounds.y - menuBounds.height;
  assert.ok(gap >= 0 && gap <= 10, `Filtered picker must stay anchored: ${gap}`);
  await page.keyboard.press('Escape');
  checks.push('a filtered picker stays anchored in a short sidebar');
  await writeFile(`${artifacts}/report.json`, JSON.stringify({ version: manifest.version, checks, chatCalls, artifacts, realModelsUsed: false }, null, 2) + '\n');
  console.log(JSON.stringify({ version: manifest.version, checks, chatCalls, artifacts, realModelsUsed: false }, null, 2));
} catch (error) {
  for (const context of contexts) for (const page of context.pages()) if (page.url().includes('sidepanel')) {
    await page.screenshot({ path: `${artifacts}/failure-${contexts.indexOf(context)}.png` }).catch(() => {});
  }
  console.error('Artifacts:', artifacts);
  throw error;
} finally {
  for (const context of contexts) await context.close();
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
}
