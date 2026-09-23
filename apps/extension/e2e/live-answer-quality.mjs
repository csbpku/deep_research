import { existsSync } from 'node:fs';
import { chromium } from '../../../apps/web/node_modules/@playwright/test/index.mjs';

const articleUrl = process.env.READER_QUALITY_URL
  || 'https://claude.com/blog/the-ai-native-sdlc-playbook';
const providerKind = process.env.READER_LIVE_PROVIDER === 'anthropic'
  ? 'custom-anthropic'
  : 'custom';
const baseUrl = process.env.READER_LIVE_BASE_URL;
const model = process.env.READER_LIVE_MODEL;
const apiKey = process.env.READER_LIVE_API_KEY;
if (!baseUrl || !model || !apiKey) {
  throw new Error('质量验收需要 READER_LIVE_BASE_URL、READER_LIVE_MODEL 和 READER_LIVE_API_KEY');
}

const extensionPath = new URL('../.output/chrome-mv3', import.meta.url).pathname;
const executablePath = process.env.CHROME_FOR_TESTING
  || [
    '/Users/shaobo.chen/Library/Caches/ms-playwright/chromium-1234/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  ].find(existsSync);
if (!executablePath) throw new Error('找不到 Chrome，请设置 CHROME_FOR_TESTING');

const profilePath = `/private/tmp/deep-research-reader-quality-${Date.now()}`;
const context = await chromium.launchPersistentContext(profilePath, {
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
let partialResults = [];
let qualityError = null;

function compact(value, limit = 7_000) {
  const text = String(value || '').trim();
  return text.length > limit ? `${text.slice(0, limit)}…` : text;
}

async function waitForAssistantCount(panel, count) {
  await panel.waitForFunction((expected) => {
    const messages = document.querySelectorAll('.conversation-message.assistant');
    const output = document.querySelector('#answer-output');
    const running = output && !output.classList.contains('hidden') && (output.textContent || '').includes('正在');
    return messages.length >= expected && !running;
  }, count, { timeout: 180_000 });
}

async function readResult(panel, label) {
  return panel.evaluate((resultLabel) => {
    const messages = Array.from(document.querySelectorAll('.conversation-message.assistant'));
    const last = messages.at(-1);
    const text = last?.querySelector('.conversation-message-body')?.textContent?.trim() || '';
    const evidence = Array.from(document.querySelectorAll('#answer-evidence-list .evidence-item'))
      .map((item) => item.textContent?.trim() || '')
      .filter(Boolean);
    const background = document.querySelector('#answer-background-text')?.textContent?.trim() || '';
    const inference = document.querySelector('#answer-inference-text')?.textContent?.trim() || '';
    const limitations = Array.from(document.querySelectorAll('#answer-limitations-list li'))
      .map((item) => item.textContent?.trim() || '')
      .filter(Boolean);
    const warnings = document.querySelector('#answer-warnings')?.textContent?.trim() || '';
    return {
      label: resultLabel,
      scope: document.querySelector('#discussion-context')?.textContent?.trim() || '',
      answer: text,
      evidence,
      background,
      inference,
      limitations,
      warnings,
      structuredVisible: !document.querySelector('#answer-structured')?.classList.contains('hidden'),
      answerOutput: document.querySelector('#answer-output')?.textContent?.trim() || '',
    };
  }, label);
}

try {
  const serviceWorker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
  const extensionId = new URL(serviceWorker.url()).host;
  const article = await context.newPage();
  const response = await article.goto(articleUrl, { waitUntil: 'domcontentloaded', timeout: 60_000 });
  await article.waitForTimeout(2_000);

  const panel = await context.newPage();
  await panel.goto(`chrome-extension://${extensionId}/sidepanel.html`, { waitUntil: 'domcontentloaded' });
  await article.bringToFront();
  const activation = await serviceWorker.evaluate(async () => {
    const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    if (!tab?.id) throw new Error('文章标签页没有成为当前标签页');
    await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['content.js'] });
    chrome.tabs.sendMessage(tab.id, { type: 'deep-research:request-page' }).catch(() => {});
    return { tabId: tab.id, windowId: tab.windowId };
  });
  await panel.bringToFront();
  await panel.waitForFunction(() => {
    const title = document.querySelector('#page-title')?.textContent || '';
    const source = document.querySelector('#page-source')?.textContent || '';
    return title && source.startsWith('http');
  }, null, { timeout: 30_000 });

  await panel.locator('#settings-button').click();
  await panel.locator('#provider-kind').selectOption(providerKind);
  await panel.locator('#provider-url').fill(baseUrl);
  await panel.locator('#provider-model').fill(model);
  await panel.locator('#provider-key').fill(apiKey);
  await panel.locator('#request-provider-origin').uncheck();
  await panel.locator('#save-settings').click();
  await panel.waitForFunction(() => {
    const text = document.querySelector('#settings-notice')?.textContent || '';
    return text.includes('模型连接成功') || text.includes('模型连接成功；');
  }, null, { timeout: 180_000 });
  await panel.locator('#close-settings').click();

  const results = [];
  partialResults = results;
  const record = async (label) => {
    const result = await readResult(panel, label);
    results.push(result);
    console.log(JSON.stringify({
      completed: label,
      scope: result.scope,
      answer: compact(result.answer),
      evidenceCount: result.evidence.length,
      warnings: result.warnings,
    }));
    return result;
  };
  await panel.locator('#quick-summary').click();
  await waitForAssistantCount(panel, 1);
  await record('全文总结');

  const questions = [
    [
      '机制解释',
      '文章为什么说当 agentic coding 让写代码不再是瓶颈后，SDLC 反而会成为新瓶颈？请区分文章明确结论和你的推断。',
    ],
    [
      '人工审批边界',
      '文章是否主张取消人工审批？请先回答“是”或“否”，再给出原文依据，并说明人工判断应该放在哪些阶段。',
    ],
    [
      '风险与反例',
      '这套 AI-native SDLC 方案最容易在哪些前提不成立时失效？请只列出文章明确提到或能被原文直接支持的风险。',
    ],
  ];
  for (const [label, question] of questions) {
    const before = await panel.locator('.conversation-message.assistant').count();
    await panel.locator('#question-input').fill(question);
    await panel.locator('#send-question').click();
    await waitForAssistantCount(panel, before + 1);
    await record(label);
  }

  await article.bringToFront();
  const selection = await article.evaluate(() => {
    const candidates = Array.from(document.querySelectorAll('article p, main p, [role="main"] p'))
      .filter((node) => (node.innerText || '').trim().length >= 100);
    const node = candidates.find((item) => /SDLC|agentic|approval|workflow|code/iu.test(item.innerText || '')) || candidates[0];
    if (!node) return '';
    const range = document.createRange();
    range.selectNodeContents(node);
    const current = window.getSelection();
    current?.removeAllRanges();
    current?.addRange(range);
    node.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
    return (node.innerText || '').trim();
  });
  if (selection) {
    await panel.locator('#selection-section').waitFor({ state: 'visible', timeout: 20_000 });
    const before = await panel.locator('.conversation-message.assistant').count();
    await panel.locator('#explain-selection').click();
    try {
      await waitForAssistantCount(panel, before + 1);
      await record('选段解读');
    } catch (error) {
      qualityError = {
        stage: '选段解读',
        message: error instanceof Error ? error.message : String(error),
        panel: await panel.evaluate(() => ({
          notice: document.querySelector('#notice')?.textContent || '',
          context: document.querySelector('#discussion-context')?.textContent || '',
          answer: document.querySelector('#answer-output')?.textContent || '',
          assistantCount: document.querySelectorAll('.conversation-message.assistant').length,
        })),
      };
    }
  }

  const sourceInfo = await article.evaluate(() => ({
    title: document.title,
    url: location.href,
    bodyChars: (document.body?.innerText || '').length,
    selectedChars: window.getSelection()?.toString().length || 0,
  }));
  console.log(JSON.stringify({
    ok: !qualityError,
    model,
    status: response?.status() ?? null,
    sourceInfo,
    activation,
    error: qualityError,
    results: results.map((item) => ({
      ...item,
      answer: compact(item.answer),
      background: compact(item.background, 2_000),
      inference: compact(item.inference, 2_000),
    })),
  }, null, 2));
} finally {
  await context.close();
}
