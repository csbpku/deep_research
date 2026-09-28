import { createServer } from 'node:http';
import { cp, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { chromium } from '../../web/node_modules/@playwright/test/index.mjs';

const extensionPath = new URL('../.output/chrome-mv3', import.meta.url).pathname;
const targetUrl = process.env.READER_TARGET_URL || '';
const liveProvider = process.env.READER_LIVE === '1';
if (targetUrl && !liveProvider) throw new Error('真实 URL 验收需要 READER_LIVE=1');
const liveBaseUrl = String(process.env.READER_LIVE_BASE_URL || '').trim().replace(/\/+$/u, '');
const liveApiKey = String(process.env.READER_LIVE_API_KEY || '').trim();
if (liveProvider && (!liveBaseUrl || !liveApiKey)) {
  throw new Error('真实模型验收需要 READER_LIVE_BASE_URL 和 READER_LIVE_API_KEY');
}
const testExtensionRoot = await mkdtemp('/private/tmp/deep-research-reader-full-page-');
const testExtensionPath = `${testExtensionRoot}/extension`;
await cp(extensionPath, testExtensionPath, { recursive: true });
const testManifestPath = `${testExtensionPath}/manifest.json`;
const testManifest = JSON.parse(await readFile(testManifestPath, 'utf8'));
testManifest.host_permissions = [...new Set([
  ...(testManifest.host_permissions || []),
  'http://127.0.0.1/*',
  ...(targetUrl ? [`${new URL(targetUrl).origin}/*`] : []),
])];
await writeFile(testManifestPath, JSON.stringify(testManifest));
const paragraphs = Array.from({ length: 1_030 }, (_, index) => (
  `<p id="paragraph-${index}">Section ${index + 1}: this technical passage must remain in the full-page translation queue.</p>`
)).join('');
const longParagraph = `<p id="long-paragraph">Long technical paragraph: ${'This complete source sentence must be preserved across translation chunks. '.repeat(420)}LONG_PARAGRAPH_TAIL_SENTINEL</p>`;
const diagramSvg = '<svg xmlns="http://www.w3.org/2000/svg" width="240" height="100"><rect width="240" height="100" fill="#fff"/><text x="12" y="55" font-size="18">Request flow</text></svg>';
const diagramUrl = `data:image/svg+xml;base64,${Buffer.from(diagramSvg).toString('base64')}`;
const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Full page translation coverage</title></head><body><main><article>
  <h1>Technical article translation coverage</h1>
  <img id="diagram" src="${diagramUrl}" width="240" height="100" alt="Request flow diagram" />
  <ul><li id="short-toc">Plays</li><li>Stage 1 - Plan</li></ul>
  <h2 id="short-heading">Plays</h2>
  ${paragraphs}
  ${longParagraph}
  <table><thead><tr><th>Stage</th><th>AI-native SDLC</th></tr></thead><tbody><tr><td>Maintain</td><td id="last-table-cell">Agents monitor live deployments and write breached controls back into intent.md.</td></tr></tbody></table>
  <div class="w-embed" id="custom-metrics-table">
    <div class="sd-k" id="custom-table-heading">How to measure it</div>
    <div class="sd-kv" id="custom-leading"><div><b>Leading indicator</b></div><div>The share of pipeline failures triaged without paging a human taken from the CI/CD pipeline logs.</div></div>
    <div class="sd-kv" id="custom-lagging"><div><b>Lagging indicator</b></div><div>DevOps Research and Assessment (DORA) measures, which the CI system and deployment tooling already emit.</div></div>
  </div>
</article></main></body></html>`;

let translationRequests = 0;
const liveRequestMetrics = { requestCount: 0, categoryCounts: {}, statusCounts: {}, upstreamDurationMs: 0 };
const fixtureServer = createServer((_request, response) => {
  response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
  response.end(html);
});
await new Promise((resolve, reject) => {
  fixtureServer.once('error', reject);
  fixtureServer.listen(0, '127.0.0.1', resolve);
});
const fixturePort = fixtureServer.address().port;

const providerServer = createServer(async (request, response) => {
  response.setHeader('access-control-allow-origin', '*');
  response.setHeader('access-control-allow-headers', 'content-type, authorization');
  response.setHeader('access-control-allow-methods', 'POST, OPTIONS');
  if (request.method === 'OPTIONS') {
    response.writeHead(204);
    response.end();
    return;
  }
  let raw = '';
  for await (const chunk of request) raw += chunk;
  if (liveProvider) {
    let category = 'other';
    try {
      const messages = JSON.parse(raw).messages || [];
      const system = String(messages.find((message) => message.role === 'system')?.content || '');
      category = system.includes('视觉能力检查器') ? 'vision-check'
        : system.includes('图片翻译器') ? 'image-translation'
          : system.includes('技术文档翻译器') ? 'text-translation' : 'other';
    } catch {}
    const startedAt = Date.now();
    liveRequestMetrics.requestCount += 1;
    liveRequestMetrics.categoryCounts[category] = (liveRequestMetrics.categoryCounts[category] || 0) + 1;
    const requestUrl = new URL(request.url || '/', 'http://127.0.0.1');
    const upstreamPath = requestUrl.pathname.replace(/^\/v1(?=\/|$)/u, '') || '/';
    const upstreamUrl = `${liveBaseUrl}${upstreamPath}${requestUrl.search}`;
    const init = {
      method: request.method,
      headers: { authorization: `Bearer ${liveApiKey}`, 'content-type': request.headers['content-type'] || 'application/json' },
    };
    if (request.method !== 'GET' && request.method !== 'HEAD') init.body = raw;
    try {
      const upstream = await fetch(upstreamUrl, init);
      liveRequestMetrics.upstreamDurationMs += Date.now() - startedAt;
      liveRequestMetrics.statusCounts[upstream.status] = (liveRequestMetrics.statusCounts[upstream.status] || 0) + 1;
      response.writeHead(upstream.status, {
        'content-type': upstream.headers.get('content-type') || 'application/json',
        'cache-control': 'no-store',
      });
      response.end(Buffer.from(await upstream.arrayBuffer()));
    } catch {
      liveRequestMetrics.upstreamDurationMs += Date.now() - startedAt;
      liveRequestMetrics.statusCounts.error = (liveRequestMetrics.statusCounts.error || 0) + 1;
      response.writeHead(502, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ error: { message: '模型代理连接失败' } }));
    }
    return;
  }
  const payload = raw ? JSON.parse(raw) : {};
  const content = String(payload.messages?.at(-1)?.content || '');
  const system = String(payload.messages?.find((message) => message.role === 'system')?.content || '');
  const messageContent = payload.messages?.at(-1)?.content;
  if (system.includes('视觉能力检查器')) {
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ choices: [{ message: { content: 'READER_VISION_CHECK' } }] }));
    return;
  }
  if (Array.isArray(messageContent) && messageContent.some((part) => part?.type === 'image_url')) {
    translationRequests += 1;
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify({
      hasReadableText: true,
      regions: [{ text: 'Request flow', translation: '请求流', x: 10, y: 35, width: 120, height: 25 }],
      confidence: 0.99,
      fallbackTranslation: '',
      note: '',
    }) } }] }));
    return;
  }
  if (content.includes('<<<TRANSLATION_BATCH>>>')) {
    translationRequests += 1;
    const batch = JSON.parse(content.split('<<<TRANSLATION_BATCH>>>\n')[1]);
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify({
      translations: batch.blocks.map(({ id, text }) => ({ id, text: `译文：${text}` })),
    }) } }] }));
    return;
  }
  if (content.includes('<<<SOURCE_TEXT>>>')) {
    translationRequests += 1;
    const source = content.match(/<<<SOURCE_TEXT>>>\n([\s\S]*?)\n<<<END_SOURCE_TEXT>>>/u)?.[1] || '';
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ choices: [{ message: { content: `译文：${source}` } }] }));
    return;
  }
  response.writeHead(200, { 'content-type': 'application/json' });
  response.end(JSON.stringify({ choices: [{ message: { content: 'READER_VISION_CHECK' } }] }));
});
await new Promise((resolve, reject) => {
  providerServer.once('error', reject);
  providerServer.listen(0, '127.0.0.1', resolve);
});
const providerPort = providerServer.address().port;

const executablePath = process.env.CHROME_FOR_TESTING
  || [
    '/Users/shaobo.chen/Library/Caches/ms-playwright/chromium-1234/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  ].find(existsSync);
if (!executablePath) throw new Error('找不到 Chrome，请设置 CHROME_FOR_TESTING');

const context = await chromium.launchPersistentContext(`/private/tmp/deep-research-reader-coverage-${Date.now()}`, {
  executablePath,
  headless: process.env.READER_HEADLESS === '1',
  viewport: { width: 1280, height: 900 },
  args: [
    '--enable-extensions',
    `--disable-extensions-except=${testExtensionPath}`,
    `--load-extension=${testExtensionPath}`,
    '--no-first-run',
    '--no-default-browser-check',
  ],
});

try {
  const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
  const extensionId = new URL(worker.url()).host;
  const fixture = await context.newPage();
  await fixture.goto(targetUrl || `http://127.0.0.1:${fixturePort}/article`, { waitUntil: 'domcontentloaded' });
  if (targetUrl) {
    await fixture.waitForTimeout(2_000);
    await fixture.evaluate(() => document.querySelectorAll('img,svg').forEach((node) => node.remove()));
  }
  const panel = await context.newPage();
  await panel.goto(`chrome-extension://${extensionId}/sidepanel.html`, { waitUntil: 'domcontentloaded' });
  await fixture.bringToFront();
  await worker.evaluate(async () => {
    const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    if (!tab?.id) throw new Error('fixture tab 未激活');
    await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['content.js'] });
    await chrome.tabs.sendMessage(tab.id, { type: 'deep-research:request-page' });
  });
  await panel.locator('#page-view').waitFor({ state: 'visible', timeout: 10_000 });
  await panel.locator('#settings-button').click();
  await panel.locator('#provider-kind').selectOption(process.env.READER_LIVE_PROVIDER === 'anthropic' ? 'custom-anthropic' : 'custom');
  await panel.locator('#provider-url').fill(`http://127.0.0.1:${providerPort}/v1`);
  await panel.locator('#provider-model').fill(liveProvider ? process.env.READER_LIVE_MODEL : 'coverage-test');
  await panel.locator('#provider-key').fill('local-only-test-key');
  await panel.locator('#request-provider-origin').uncheck();
  await panel.locator('#save-settings').click();
  await panel.waitForFunction(() => document.querySelector('#settings-notice')?.textContent?.includes('模型连接成功'), null, {
    timeout: liveProvider ? 120_000 : 10_000,
  });
  await panel.locator('#close-settings').click();

  const initiallyVisibleBlockIds = targetUrl ? await fixture.evaluate(() => [...document.querySelectorAll('[data-deep-research-block]')]
    .filter((node) => {
      const rect = node.getBoundingClientRect();
      return rect.bottom > 0 && rect.top < innerHeight && rect.width > 0 && rect.height > 0;
    })
    .map((node) => node.getAttribute('data-deep-research-block'))) : [];

  const translationStartedAt = Date.now();
  await panel.locator('#translate-all').click();
  await panel.waitForFunction(() => {
    const notice = document.querySelector('#notice')?.textContent || '';
    return notice.includes('全文翻译完成') || notice.includes('翻译完成，但') || notice.includes('翻译失败');
  }, null, { timeout: liveProvider ? 300_000 : 120_000 });
  const translationElapsedMs = Date.now() - translationStartedAt;
  if (targetUrl) {
    await fixture.evaluate(() => window.scrollTo(0, 0));
    const liveResult = await fixture.evaluate((initiallyVisibleIds) => {
      const blocks = [...document.querySelectorAll('[data-deep-research-block]')];
      const eligible = blocks.filter((node) => !node.matches('pre,code') && !node.closest('pre,code'));
      const translations = [...document.querySelectorAll('[data-deep-research-translation]')];
      const translatedIds = new Set(translations.map((node) => node.getAttribute('data-deep-research-translation-for')));
      const translated = eligible.filter((node) => translatedIds.has(node.getAttribute('data-deep-research-block')));
      const visibleTranslations = translations.filter((node) => {
        const rect = node.getBoundingClientRect();
        return rect.bottom > 0 && rect.top < innerHeight && rect.width > 0 && rect.height > 0;
      });
      const initialIds = Array.isArray(initiallyVisibleIds) ? initiallyVisibleIds : [];
      return {
        blockCount: blocks.length,
        eligibleBlocks: eligible.length,
        translatedBlocks: translated.length,
        untranslatedBlocks: eligible.length - translated.length,
        visibleBlocks: initialIds.length,
        visibleTranslatedBlocks: initialIds.filter((id) => translatedIds.has(id)).length,
        visibleUntranslated: initialIds.filter((id) => !translatedIds.has(id)).length,
        renderedTranslationsInViewport: visibleTranslations.length,
        originalHidden: translated.length === eligible.length
          && translated.every((node) => getComputedStyle(node).display === 'none'),
        codeBlocksPreserved: [...document.querySelectorAll('pre,code')]
          .every((node) => getComputedStyle(node).display !== 'none'),
      };
    }, initiallyVisibleBlockIds);
    const notice = await panel.locator('#notice').innerText();
    const translationSamples = await fixture.evaluate(() => {
      const translations = new Map([...document.querySelectorAll('[data-deep-research-translation]')]
        .map((node) => [node.getAttribute('data-deep-research-translation-for'), node]));
      const blocks = [...document.querySelectorAll('[data-deep-research-block]')];
      const sampleBlocks = [
        ...blocks.filter((node) => ['H1', 'H2'].includes(node.tagName)).slice(0, 3),
        ...blocks.filter((node) => node.tagName === 'P').slice(0, 2),
        blocks.at(-1),
      ].filter(Boolean);
      return sampleBlocks.slice(0, 6).map((node) => {
        const id = node.getAttribute('data-deep-research-block');
        return {
          element: node.tagName.toLowerCase(),
          source: (node.innerText || node.textContent || '').trim().slice(0, 220),
          translation: (translations.get(id)?.innerText || translations.get(id)?.textContent || '').trim().slice(0, 260),
        };
      });
    });
    const tableSamples = await fixture.evaluate(() => {
      const translations = new Map([...document.querySelectorAll('[data-deep-research-translation]')]
        .map((node) => [node.getAttribute('data-deep-research-translation-for'), node]));
      const blocks = [...document.querySelectorAll('[data-deep-research-block]')];
      return blocks.filter((node) => /Traditional SDLC|AI-native SDLC|How to measure it|Leading indicator|Lagging indicator|DORA measures/iu
        .test((node.innerText || node.textContent || '').trim()))
        .slice(0, 12)
        .map((node) => {
          const id = node.getAttribute('data-deep-research-block');
          return {
            source: (node.innerText || node.textContent || '').trim().slice(0, 320),
            translation: (translations.get(id)?.innerText || translations.get(id)?.textContent || '').trim().slice(0, 360),
          };
        });
    });
    const tableCoverage = await fixture.evaluate(() => {
      const translatedIds = new Set([...document.querySelectorAll('[data-deep-research-translation]')]
        .map((node) => node.getAttribute('data-deep-research-translation-for')));
      const patterns = ['How to measure it', 'Leading indicator', 'Lagging indicator'];
      return Object.fromEntries(patterns.map((pattern) => {
        const matching = [...document.querySelectorAll('[data-deep-research-block]')]
          .filter((node) => (node.innerText || node.textContent || '').includes(pattern));
        return [pattern, { blocks: matching.length, translated: matching.filter((node) => translatedIds.has(node.getAttribute('data-deep-research-block'))).length }];
      }));
    });
    if (!liveResult.eligibleBlocks || !liveResult.visibleBlocks || liveResult.visibleTranslatedBlocks !== liveResult.visibleBlocks
      || !liveResult.renderedTranslationsInViewport || liveResult.translatedBlocks !== liveResult.eligibleBlocks
      || liveResult.visibleUntranslated || !liveResult.originalHidden || !liveResult.codeBlocksPreserved
      || !notice.includes('全文翻译完成')
      || Object.values(tableCoverage).some((coverage) => !coverage.blocks || coverage.translated !== coverage.blocks)) {
      throw new Error(`真实原文全文翻译覆盖断言失败：${JSON.stringify({ liveResult, tableCoverage, notice })}`);
    }
    await fixture.evaluate(() => window.scrollTo(0, 0));
    await fixture.screenshot({ path: '/private/tmp/deep-research-reader-live-translation-top.png' });
    await fixture.evaluate(() => [...document.querySelectorAll('[data-deep-research-block]')]
      .find((node) => (node.innerText || node.textContent || '').includes('How to measure it'))
      ?.scrollIntoView({ block: 'center' }));
    await fixture.screenshot({ path: '/private/tmp/deep-research-reader-live-translation-table.png' });
    await fixture.evaluate(() => [...document.querySelectorAll('[data-deep-research-translation]')].at(-1)?.scrollIntoView({ block: 'end' }));
    await fixture.screenshot({ path: '/private/tmp/deep-research-reader-live-translation-bottom.png' });
    await panel.locator('#restore-page').click();
    await fixture.waitForFunction(() => document.querySelectorAll('[data-deep-research-translation]').length === 0, null, { timeout: 15_000 });
    console.log(JSON.stringify({ extensionId, targetUrl, model: process.env.READER_LIVE_MODEL, settingsNotice: await panel.locator('#settings-notice').textContent(), notice, translationElapsedMs, liveRequestMetrics, ...liveResult, translationSamples, tableCoverage, tableSamples, screenshots: ['/private/tmp/deep-research-reader-live-translation-top.png', '/private/tmp/deep-research-reader-live-translation-table.png', '/private/tmp/deep-research-reader-live-translation-bottom.png'], restoredTranslations: 0 }, null, 2));
    process.exitCode = 0;
  } else {
  const result = await fixture.evaluate(() => ({
    blockCount: document.querySelectorAll('[data-deep-research-block]').length,
    translatedCount: document.querySelectorAll('[data-deep-research-translation]').length,
    lastParagraphTranslated: Boolean(document.querySelector('#paragraph-1029')?.nextElementSibling?.hasAttribute('data-deep-research-translation')),
    longParagraphTranslated: Boolean(document.querySelector('#long-paragraph')?.nextElementSibling?.hasAttribute('data-deep-research-translation')),
    longParagraphTailPreserved: document.querySelector('#long-paragraph')?.nextElementSibling?.textContent?.endsWith('LONG_PARAGRAPH_TAIL_SENTINEL') || false,
    originalHidden: getComputedStyle(document.querySelector('#paragraph-0')).display === 'none',
    shortTocTranslated: Boolean(document.querySelector('#short-toc')?.nextElementSibling?.hasAttribute('data-deep-research-translation')),
    shortHeadingTranslated: Boolean(document.querySelector('#short-heading')?.nextElementSibling?.hasAttribute('data-deep-research-translation')),
    tableCellTranslated: Boolean(document.querySelector('#last-table-cell')?.nextElementSibling?.hasAttribute('data-deep-research-translation')),
    customTableHeadingTranslated: Boolean(document.querySelector('#custom-table-heading')?.nextElementSibling?.hasAttribute('data-deep-research-translation')),
    customLeadingTranslated: Boolean(document.querySelector('#custom-leading')?.nextElementSibling?.hasAttribute('data-deep-research-translation')),
    customLaggingTranslated: Boolean(document.querySelector('#custom-lagging')?.nextElementSibling?.hasAttribute('data-deep-research-translation')),
    customRowSourceHidden: getComputedStyle(document.querySelector('#custom-leading')).display === 'none',
    imageTranslationVisible: [
      ...document.querySelectorAll('[data-deep-research-image-overlay] > span'),
      ...document.querySelectorAll('[data-deep-research-image-side-translation]'),
      ...document.querySelectorAll('[data-deep-research-image-fallback]'),
    ].some((node) => node.textContent?.includes('请求流')),
    imageTranslationAnchored: [...document.querySelectorAll('[data-deep-research-image-side-translation]')]
      .some((node) => node.textContent?.includes('Request flow') && node.textContent?.includes('请求流')),
    imageSourcePreserved: Boolean(document.querySelector('#diagram')?.isConnected),
  }));
  if (result.blockCount < 1_030 || result.translatedCount !== result.blockCount
    || !result.lastParagraphTranslated || !result.shortTocTranslated
    || !result.shortHeadingTranslated || !result.tableCellTranslated
    || !result.customTableHeadingTranslated || !result.customLeadingTranslated
    || !result.customLaggingTranslated || !result.customRowSourceHidden
    || !result.longParagraphTranslated || !result.longParagraphTailPreserved || !result.originalHidden
    || !result.imageTranslationVisible || !result.imageTranslationAnchored || !result.imageSourcePreserved || translationRequests > 160) {
    throw new Error(`全文覆盖断言失败：${JSON.stringify({ result, translationRequests })}`);
  }
  await panel.locator('#restore-page').click();
  await fixture.waitForFunction(() => document.querySelectorAll('[data-deep-research-translation]').length === 0, null, { timeout: 10_000 });
  const restored = await fixture.evaluate(() => ({
    originalVisible: getComputedStyle(document.querySelector('#paragraph-0')).display !== 'none',
    longParagraphTailPreserved: document.querySelector('#long-paragraph')?.textContent?.endsWith('LONG_PARAGRAPH_TAIL_SENTINEL') || false,
    translationCount: document.querySelectorAll('[data-deep-research-translation]').length,
  }));
  if (!restored.originalVisible || !restored.longParagraphTailPreserved || restored.translationCount !== 0) {
    throw new Error(`恢复原文断言失败：${JSON.stringify(restored)}`);
  }
  console.log(JSON.stringify({ extensionId, ...result, translationRequests, restored }, null, 2));
  }
} finally {
  await context.close().catch(() => {});
  await new Promise((resolve) => providerServer.close(resolve));
  await new Promise((resolve) => fixtureServer.close(resolve));
}
