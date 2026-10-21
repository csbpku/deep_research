import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { existsSync } from 'node:fs';
import { cp, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { chromium } from '../../web/node_modules/@playwright/test/index.mjs';

let releaseAnswer;
let received;
const gate = new Promise(resolve => { releaseAnswer = resolve; });
const server = createServer(async (request, response) => {
  response.setHeader('access-control-allow-origin', '*');
  if (request.url === '/article') {
    response.setHeader('content-type', 'text/html');
    response.end('<title>Queue article</title><article><h1>Queues</h1><p>A bounded queue protects memory.</p><p>Backpressure slows producers when consumers are busy.</p></article>');
    return;
  }
  if (request.url === '/v1/models') {
    response.setHeader('content-type', 'application/json');
    response.end(JSON.stringify({ data: [{ id: 'test-chat' }] }));
    return;
  }
  if (request.method === 'OPTIONS') { response.setHeader('access-control-allow-headers', 'content-type,authorization'); response.end(); return; }
  if (request.method !== 'POST') { response.writeHead(404); response.end(); return; }
  let raw = ''; for await (const chunk of request) raw += chunk;
  received = JSON.parse(raw);
  await gate;
  response.setHeader('content-type', 'application/json');
  response.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ answer: 'The article explains bounded queues.', evidence: [] }) } }] }));
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
const root = await mkdtemp('/private/tmp/reader-prompt-visibility-');
await cp(new URL('../.output/chrome-mv3', import.meta.url).pathname, `${root}/extension`, { recursive: true });
const manifest = JSON.parse(await readFile(`${root}/extension/manifest.json`, 'utf8'));
manifest.host_permissions = [...new Set([...(manifest.host_permissions || []), 'http://127.0.0.1/*'])];
await writeFile(`${root}/extension/manifest.json`, JSON.stringify(manifest));
const executablePath = [
  '/Users/shaobo.chen/Library/Caches/ms-playwright/chromium-1234/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
].find(existsSync);
const context = await chromium.launchPersistentContext(`${root}/profile`, { executablePath, headless: true, viewport: { width: 420, height: 860 },
  args: [`--disable-extensions-except=${root}/extension`, `--load-extension=${root}/extension`] });
try {
  const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
  const id = new URL(worker.url()).host;
  await worker.evaluate(() => chrome.storage.local.set({ readerUiLanguage: 'zh-CN' }));
  const article = await context.newPage(); await article.goto(`${origin}/article`);
  await article.bringToFront();
  const tabId = await worker.evaluate(async () => (await chrome.tabs.query({ active: true, lastFocusedWindow: true }))[0].id);
  const panel = await context.newPage(); await panel.goto(`chrome-extension://${id}/sidepanel.html?sourceTab=${tabId}`);
  await panel.waitForFunction(() => document.documentElement.dataset.readerReady === 'true');
  await article.bringToFront();
  await worker.evaluate(async tabId => {
    await chrome.scripting.executeScript({ target: { tabId }, files: ['content.js'] });
    await chrome.tabs.sendMessage(tabId, { type: 'deep-research:request-page' });
  }, tabId);
  await panel.locator('#page-view').waitFor({ state: 'visible' });
  await panel.locator('#settings-button').click();
  await panel.locator('#provider-kind').selectOption('local-proxy', { force: true });
  await panel.locator('#provider-url').fill(`${origin}/v1`);
  await panel.locator('#provider-model-list option[value="test-chat"]').waitFor({ state: 'attached' });
  await panel.locator('#provider-model-list').selectOption('test-chat');
  await panel.locator('#save-settings').click();
  await panel.waitForFunction(() => document.querySelector('#settings-notice')?.dataset.result === 'success');
  await panel.locator('#close-settings').click();
  const nextDraft = 'My next question about backpressure';
  await panel.locator('#question-input').fill(nextDraft);
  await panel.locator('#notice').evaluate(node => { node.textContent = 'Old platform request failed'; });
  await panel.locator('#chat-summary').click();
  await panel.locator('#pending-question').filter({ hasText: '总结本页' }).waitFor();
  assert.equal(await panel.locator('#notice').textContent(), '', 'a new answer clears the previous task notice');
  for (let attempt = 0; !received && attempt < 200; attempt++) await new Promise(resolve => setTimeout(resolve, 50));
  assert.ok(received, `Model request was not sent: ${await panel.locator('#notice').textContent()}`);
  const prompt = received.messages.map(message => String(message.content)).join('\n');
  assert.ok(prompt.includes('严格按 Markdown'), 'model receives the internal summary instructions');
  const task = await worker.evaluate(async () => Object.entries(await chrome.storage.session.get(null)).find(([key]) => key.startsWith('readerAnswer:'))[1]);
  assert.equal(task.userMessage, '总结本页');
  assert.ok(!('prompt' in task), 'internal model prompt is absent from UI recovery state');
  await panel.reload();
  await article.bringToFront();
  await panel.locator('#pending-question').filter({ hasText: '总结本页' }).waitFor();
  assert.equal(await panel.locator('#pending-question').innerText(), '总结本页');
  assert.equal(await panel.locator('#question-input').inputValue(), nextDraft);
  assert.ok(!(await panel.locator('body').innerText()).includes('严格按 Markdown'));
  await panel.screenshot({ path: '/private/tmp/reader-summary-recovery-026.png' });
  releaseAnswer();
  await panel.locator('#conversation-list').filter({ hasText: 'The article explains bounded queues.' }).waitFor();
  assert.ok(!(await panel.locator('#conversation-list').innerText()).includes('严格按 Markdown'));

  async function legacyFailure(question, internalPrompt, draft = '') {
    await worker.evaluate(async ({ task, question, internalPrompt }) => {
      const id = `legacy-${Date.now()}`;
      await chrome.storage.session.set({ [`readerAnswer:${id}`]: { ...task, id, userMessage: undefined, intent: undefined, draft: undefined,
        question, prompt: internalPrompt, status: 'failed', error: 'Test request failed', startedAt: Date.now() + 1000 } });
    }, { task, question, internalPrompt });
    await panel.locator('#question-input').fill(draft);
    await panel.reload();
    await article.bringToFront();
    await panel.locator('#notice').filter({ hasText: 'Test request failed' }).waitFor();
    assert.match(await panel.locator('#notice').innerText(), /^上次回答未完成：/);
  }
  const internalPrompt = 'Internal summary instructions should never appear in the composer.';
  await legacyFailure('总结本页', internalPrompt, internalPrompt);
  assert.equal(await panel.locator('#question-input').inputValue(), '', 'old leaked prompt is removed');
  await legacyFailure('总结本页', internalPrompt, nextDraft);
  assert.equal(await panel.locator('#question-input').inputValue(), nextDraft, 'unrelated unsent question survives');
  await legacyFailure('Why is capacity bounded?', 'Why is capacity bounded?');
  assert.equal(await panel.locator('#question-input').inputValue(), 'Why is capacity bounded?', 'a real typed question remains retryable');
  console.log(JSON.stringify({ summaryLabelAfterReload: '总结本页', modelInstructionsHidden: true, typedDraftPreserved: true,
    legacyPromptRemoved: true, realQuestionRestored: true, screenshot: '/private/tmp/reader-summary-recovery-026.png' }));
} catch (error) {
  const panels = context.pages().filter(page => page.url().includes('sidepanel.html'));
  for (const page of panels) {
    console.error('Reader failure state:', await page.evaluate(() => ({ notice: document.querySelector('#notice')?.textContent,
      pending: document.querySelector('#pending-question')?.textContent, draft: document.querySelector('#question-input')?.value,
      settings: document.querySelector('#settings-view')?.className, page: document.querySelector('#page-view')?.className })));
    await page.screenshot({ path: '/private/tmp/reader-prompt-failure.png' });
  }
  throw error;
} finally {
  releaseAnswer();
  await context.close();
  await new Promise(resolve => server.close(resolve));
}
