import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { cp, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { chromium } from '../../web/node_modules/@playwright/test/index.mjs';
const requests = [];
const answer = JSON.stringify({ answer: 'Queues protect memory and keep work responsive.', evidence: [{ quote: 'A bounded queue protects memory.', claim: 'Memory bound' }], background: '', inference: '', limitations: [] });
const server = createServer(async (req, res) => {
  res.setHeader('access-control-allow-origin', '*');
  if (req.url === '/article') { res.setHeader('content-type', 'text/html'); res.end('<html><title>Queue guide</title><body><article><h1>Queue guide</h1><h2>Capacity</h2><p>A bounded queue protects memory.</p><p>It provides backpressure when workers are busy.</p><p>Tasks should continue when a reader selects another paragraph.</p></article></body></html>'); return; }
  if (req.url === '/v1/models') { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ data: [{ id: 'local-test-chat' }, { id: 'local-test-vision' }] })); return; }
  let raw = ''; for await (const chunk of req) raw += chunk;
  const input = JSON.parse(raw || '{}'); requests.push(input);
  res.setHeader('content-type', input.stream ? 'text/event-stream' : 'application/json');
  let text = answer;
  const user = String(input.messages?.at(-1)?.content || '');
  const system = String(input.messages?.[0]?.content || '');
  if (user.includes('Reply with OK')) text = 'OK';
  else if (system.includes('翻译编辑')) {
    const json = user.split('<<<TRANSLATION_BATCH>>>\n')[1];
    text = json ? JSON.stringify({ translations: JSON.parse(json).blocks.map(b => ({ id: b.id, text: '译文：'+b.text })) }) : '译文：A bounded queue protects memory.';
  }
  if (input.stream) {
    await new Promise(resolve => setTimeout(resolve, 800));
    res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: text.slice(0, 80) } }] })}\n\n`);
    await new Promise(resolve => setTimeout(resolve, 1500));
    res.end(`data: ${JSON.stringify({ choices: [{ delta: { content: text.slice(80) } }] })}\n\ndata: [DONE]\n\n`);
  } else res.end(JSON.stringify({ choices: [{ message: { content: text } }] }));
});
await new Promise(resolve => server.listen(8879, '127.0.0.1', resolve));
const root = await mkdtemp('/private/tmp/reader-chat-workspace-');
await cp(new URL('../.output/chrome-mv3', import.meta.url).pathname, root+'/extension', { recursive: true });
const manifest = JSON.parse(await readFile(root+'/extension/manifest.json', 'utf8'));
manifest.host_permissions = ['http://127.0.0.1/*'];
await writeFile(root+'/extension/manifest.json', JSON.stringify(manifest));
const executablePath = ['/Users/shaobo.chen/Library/Caches/ms-playwright/chromium-1234/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing', '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'].find(existsSync);
const context = await chromium.launchPersistentContext(root+'/profile', { executablePath, headless: true, args: [`--disable-extensions-except=${root}/extension`, `--load-extension=${root}/extension`], viewport: { width: 380, height: 860 } });
try {
  const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
  const id = new URL(worker.url()).host;
  const fixture = await context.newPage(); await fixture.goto('http://127.0.0.1:8879/article');
  let panel = await context.newPage(); await panel.goto(`chrome-extension://${id}/sidepanel.html`);
  await panel.waitForFunction(() => document.documentElement.dataset.readerReady === 'true');
  await fixture.bringToFront();
  await worker.evaluate(async () => { const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true }); await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['content.js'] }); await chrome.tabs.sendMessage(tab.id, { type: 'deep-research:request-page' }); });
  await panel.locator('#page-view').waitFor({ state: 'visible' });
  assert.equal(await panel.locator('#nav-tools').count(), 0);
  await panel.locator('#settings-button').click();
  await panel.locator('#provider-kind').selectOption('local-proxy');
  await panel.locator('#provider-url').fill('http://127.0.0.1:8879/v1');
  await panel.locator('#provider-model-list option[value="local-test-chat"]').waitFor({ state: 'attached' });
  await panel.locator('#provider-model-list').selectOption('local-test-chat');
  await panel.locator('#request-provider-origin').uncheck();
  await panel.locator('#save-settings').click();
  await panel.locator('#settings-notice').filter({ hasText: '连接成功' }).waitFor();
  assert.equal(requests.filter(r => r.messages).length, 1, 'quick validation sends one text call, no image probe');
  await panel.locator('#close-settings').click();
  await panel.locator('#question-input').fill('Why does the queue have a bound?');
  await panel.locator('#send-question').click();
  await panel.locator('#stop-answer').waitFor({ state: 'visible' });
  // A real selection event used to abort this request.
  await fixture.evaluate(() => { const p = document.querySelectorAll('p')[1]; const range = document.createRange(); range.selectNodeContents(p); const selection = getSelection(); selection.removeAllRanges(); selection.addRange(range); p.dispatchEvent(new MouseEvent('mouseup', { bubbles: true })); });
  await panel.locator('#scope-selection').waitFor({ state: 'visible' });
  assert.ok(await panel.locator('#stop-answer').isVisible());
  await panel.locator('#chat-tools-menu summary').first().click();
  await panel.locator('#translate-all').click();
  await fixture.locator('[data-deep-research-translation-for]').first().waitFor();
  await panel.close();
  await new Promise(resolve => setTimeout(resolve, 2500));
  panel = await context.newPage(); await panel.goto(`chrome-extension://${id}/sidepanel.html`);
  await panel.waitForFunction(() => document.documentElement.dataset.readerReady === 'true');
  await fixture.bringToFront();
  await worker.evaluate(async () => { const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true }); await chrome.tabs.sendMessage(tab.id, { type: 'deep-research:request-page' }); });
  await panel.locator('#conversation-list').filter({ hasText: 'Queues protect memory' }).waitFor();
  const answerRequests = requests.filter(r => r.stream);
  assert.equal(answerRequests.length, 1, 'reopening panel does not restart the answer');
  const translated = fixture.locator('[data-deep-research-translation-for]').first();
  const blockId = await translated.getAttribute('data-deep-research-translation-for');
  await translated.hover(); await fixture.keyboard.press('Alt+Shift+KeyO');
  await fixture.locator(`[data-deep-research-block="${blockId}"]`).waitFor({ state: 'visible' });
  assert.ok(await translated.isHidden());
  await fixture.locator(`[data-deep-research-block="${blockId}"]`).hover(); await fixture.keyboard.press('Alt+Shift+KeyO');
  await translated.waitFor({ state: 'visible' });
  // A selection action survives a panel that has not mounted yet.
  await panel.locator('#chat-tools-menu summary').first().click();
  await panel.locator('#restore-page').click();
  await fixture.locator('[data-deep-research-translation-for]').first().waitFor({ state: 'hidden' });
  await panel.close();
  await fixture.evaluate(() => { const p = document.querySelectorAll('p')[2]; const range = document.createRange(); range.selectNodeContents(p); getSelection().removeAllRanges(); getSelection().addRange(range); });
  await fixture.bringToFront();
  await worker.evaluate(async () => { const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true }); await chrome.tabs.sendMessage(tab.id, { type: 'deep-research:context-action', action: 'ask' }); });
  await worker.evaluate(async () => { for (let i = 0; i < 30; i++) { if ((await chrome.storage.session.get('readerPendingSelectionAction')).readerPendingSelectionAction) return; await new Promise(resolve => setTimeout(resolve, 50)); } throw new Error('selection action was not persisted'); });
  const sourceTab = await worker.evaluate(async () => (await chrome.storage.session.get('readerPendingSelectionAction')).readerPendingSelectionAction.tabId);
  panel = await context.newPage(); await panel.goto(`chrome-extension://${id}/sidepanel.html?sourceTab=${sourceTab}`);
  await panel.waitForFunction(() => document.documentElement.dataset.readerReady === 'true');
  await fixture.bringToFront();
  await panel.locator('#chat-selection-quote').filter({ hasText: 'Tasks should continue' }).waitFor({ state: 'attached' });
  await panel.waitForFunction(() => document.querySelector('#scope-selection')?.getAttribute('aria-pressed') === 'true');
  await panel.locator('#question-input').fill('Stop this test answer.');
  await panel.locator('#send-question').click();
  await panel.locator('#stop-answer').waitFor({ state: 'visible' });
  await panel.locator('#stop-answer').click();
  await panel.locator('#stop-answer').waitFor({ state: 'hidden' });
  assert.equal(await panel.locator('#conversation-list').filter({ hasText: 'Stop this test answer.' }).count(), 0);
  await panel.screenshot({ path: root+'/chat.png' });
  console.log(JSON.stringify({ pass: true, quickValidationCalls: 1, answerCallsAfterSelectionTranslationAndPanelReopen: answerRequests.length, paragraphToggle: true, deferredSelectionAction: true, explicitStop: true, artifact: root+'/chat.png' }));
} catch (error) { for (const page of context.pages()) if (page.url().includes('sidepanel')) { await page.screenshot({ path: root+'/failure.png' }); console.error('Screenshot:', root+'/failure.png'); console.error((await page.locator('#notice').textContent()) || ''); } throw error; } finally { await context.close(); server.close(); }
