import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { chromium } from '../../web/node_modules/@playwright/test/index.mjs';

const extensionPath = new URL('../.output/chrome-mv3', import.meta.url).pathname;
const fixturePath = new URL('./fixture.html', import.meta.url);
const fixturePort = 8770;
const providerPort = 8804;
// Keep this control test focused on task state transitions. Dynamic-content
// replacement has its own 24-page matrix; removing the fixture's timer here
// prevents an unrelated incremental job from racing the retry assertion.
const fixtureHtml = (await readFile(fixturePath, 'utf8')).replace(/<script>[\s\S]*?<\/script>/u, '');
let failedTranslationOnce = true;
let requestCount = 0;
const requestKinds = [];

const fixtureServer = createServer((_request, response) => {
  response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
  response.end(fixtureHtml);
});
await new Promise((resolve, reject) => {
  fixtureServer.once('error', reject);
  fixtureServer.listen(fixturePort, '127.0.0.1', resolve);
});

const providerServer = createServer(async (request, response) => {
  if (request.method === 'OPTIONS') {
    response.writeHead(204, {
      'access-control-allow-origin': '*',
      'access-control-allow-headers': 'content-type, authorization',
      'access-control-allow-methods': 'POST, OPTIONS',
    });
    response.end();
    return;
  }
  let raw = '';
  for await (const chunk of request) raw += chunk;
  const payload = raw ? JSON.parse(raw) : {};
  requestCount += 1;
  const system = String(payload.messages?.find((item) => item.role === 'system')?.content || '');
  requestKinds.push(system.slice(0, 80));
  const user = payload.messages?.at(-1);
  const content = Array.isArray(user?.content)
    ? user.content.map((part) => part.text || '').join('\n')
    : String(user?.content || '');
  const hasImage = Array.isArray(user?.content) && user.content.some((part) => part.type === 'image_url');

  if (system.includes('视觉能力检查器')) {
    response.writeHead(200, { 'content-type': 'application/json', 'access-control-allow-origin': '*' });
    response.end(JSON.stringify({ choices: [{ message: { content: 'READER_VISION_CHECK' } }] }));
    return;
  }
  // Make one text block fail exactly once. This exercises the visible failed
  // item and the single-item retry path without making the whole task fail.
  if (failedTranslationOnce && (system.includes('技术文档翻译器') || system.includes('图片翻译器'))) {
    failedTranslationOnce = false;
    response.writeHead(503, { 'content-type': 'application/json', 'access-control-allow-origin': '*' });
    response.end(JSON.stringify({ error: { message: 'temporary test rate limit' } }));
    return;
  }
  let answer = '有界队列可以让浏览器工作保持响应。';
  if (system.includes('图片翻译器')) {
    const raster = content.includes('Raster queue diagram');
    answer = JSON.stringify({
      regions: [raster
        ? { text: 'Raster Queue', translation: '栅格队列', x: 16, y: 34, width: 180, height: 44 }
        : { text: 'Bounded Queue', translation: '有界队列', x: 286, y: 22, width: 190, height: 72 }],
      confidence: 0.95,
      fallbackTranslation: '',
      note: '',
    });
  } else if (system.includes('图示解读助手')) {
    answer = JSON.stringify({ answer: '图示展示了有界队列和工作器之间的处理关系。', evidence: [], background: '', inference: '', limitations: [] });
  } else if (hasImage) {
    answer = '图中展示了一个有界队列。';
  } else if (system.includes('技术阅读助手')) {
    answer = JSON.stringify({ answer: '有界队列限制同时处理的工作量。', evidence: [], background: '', inference: '', limitations: [] });
  }
  await new Promise((resolve) => setTimeout(resolve, 260));
  response.writeHead(200, {
    'content-type': payload.stream ? 'text/event-stream' : 'application/json',
    'access-control-allow-origin': '*',
  });
  const result = { choices: [{ message: { content: answer } }] };
  if (payload.stream) {
    response.end(`data: ${JSON.stringify({ choices: [{ delta: { content: answer } }] })}\n\ndata: [DONE]\n\n`);
  } else {
    response.end(JSON.stringify(result));
  }
});
await new Promise((resolve, reject) => {
  providerServer.once('error', reject);
  providerServer.listen(providerPort, '127.0.0.1', resolve);
});

const executablePath = process.env.CHROME_FOR_TESTING
  || [
    '/Users/shaobo.chen/Library/Caches/ms-playwright/chromium-1234/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  ].find(existsSync);
if (!executablePath) throw new Error('找不到 Chrome，请设置 CHROME_FOR_TESTING');

const profilePath = `/private/tmp/deep-research-reader-controls-${Date.now()}`;
const context = await chromium.launchPersistentContext(profilePath, {
  executablePath,
  headless: process.env.READER_HEADLESS === '1',
  viewport: { width: 1280, height: 900 },
  args: ['--enable-extensions', `--disable-extensions-except=${extensionPath}`, `--load-extension=${extensionPath}`, '--no-first-run', '--no-default-browser-check'],
});

try {
  const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
  const extensionId = new URL(worker.url()).host;
  const fixture = await context.newPage();
  await fixture.goto(`http://127.0.0.1:${fixturePort}/fixture.html`, { waitUntil: 'domcontentloaded' });
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
  await panel.locator('#provider-kind').selectOption('custom');
  await panel.locator('#provider-url').fill(`http://127.0.0.1:${providerPort}/v1`);
  await panel.locator('#provider-model').fill('controls-reader');
  await panel.locator('#provider-key').fill('local-test-key');
  if (!await panel.getByText('卸载扩展前请先导出需要保留的阅读成果').isVisible()) {
    throw new Error('设置页没有显示卸载前导出提示');
  }
  await panel.locator('#request-provider-origin').uncheck();
  await panel.locator('#save-settings').click();
  await panel.locator('#settings-notice').waitFor({ state: 'visible', timeout: 10_000 });
  await panel.locator('#close-settings').click();

  // Tables are part of technical documentation, but a structured cell can
  // also contain a paragraph. The content script must index a plain cell and
  // its nested paragraph without creating two copies of the same passage.
  await fixture.evaluate(() => {
    document.querySelector('article')?.insertAdjacentHTML('beforeend', `
      <h2 id="table-heading">Runtime choices</h2>
      <table id="reading-table">
        <thead><tr><th>Component</th><th>Decision</th></tr></thead>
        <tbody><tr>
          <td id="plain-table-cell">Bounded queue capacity</td>
          <td id="nested-table-cell"><p id="nested-table-p">Cancellation should stop stale work before it consumes model capacity.</p></td>
        </tr></tbody>
      </table>`);
  });
  await worker.evaluate(async () => {
    const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    if (tab?.id) await chrome.tabs.sendMessage(tab.id, { type: 'deep-research:request-page' });
  });
  await fixture.waitForFunction(() => {
    const plain = document.querySelector('#plain-table-cell');
    const nestedCell = document.querySelector('#nested-table-cell');
    const nestedParagraph = document.querySelector('#nested-table-p');
    return Boolean(plain?.getAttribute('data-deep-research-block')
      && !nestedCell?.getAttribute('data-deep-research-block')
      && nestedParagraph?.getAttribute('data-deep-research-block'));
  }, null, { timeout: 10_000 });
  const tableBlocks = await fixture.evaluate(() => ({
    plainCell: document.querySelector('#plain-table-cell')?.getAttribute('data-deep-research-block') || null,
    nestedCell: document.querySelector('#nested-table-cell')?.getAttribute('data-deep-research-block') || null,
    nestedParagraph: document.querySelector('#nested-table-p')?.getAttribute('data-deep-research-block') || null,
  }));
  if (!tableBlocks.plainCell || tableBlocks.nestedCell || !tableBlocks.nestedParagraph) {
    throw new Error(`表格正文块索引错误：${JSON.stringify(tableBlocks)}`);
  }
  await worker.evaluate(async ({ quote }) => {
    const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    if (tab?.id) await chrome.tabs.sendMessage(tab.id, { type: 'deep-research:focus-anchor', anchor: { quote } });
  }, { quote: 'Cancellation should stop stale work before it consumes model capacity.' });
  await fixture.waitForFunction(() => Boolean(document.querySelector('#nested-table-p')?.style.outline), null, { timeout: 10_000 });

  // First let one item fail, then prove that the visible single-item retry
  // removes only that failure without rerunning the whole document.
  await panel.locator('#translate-all').click();
  try {
    await panel.locator('#translation-failures').waitFor({ state: 'visible', timeout: 60_000 });
  } catch (error) {
    console.error(JSON.stringify({
      requestCount,
      requestKinds,
      failedTranslationOnce,
      notice: await panel.locator('#notice').innerText().catch(() => ''),
      progress: await panel.locator('#progress-area').innerText().catch(() => ''),
      body: (await panel.locator('body').innerText().catch(() => '')).slice(-2500),
    }, null, 2));
    throw error;
  }
  const failureText = await panel.locator('#translation-failures').innerText();
  if (!failureText.includes('重试')) throw new Error(`失败项没有显示重试入口：${failureText}`);
  await panel.locator('.translation-retry').first().click();
  try {
    await panel.waitForFunction(() => !document.querySelector('#translation-failures')?.textContent?.includes('需要处理'), null, { timeout: 30_000 });
  } catch (error) {
    console.error(JSON.stringify({
      failureText,
      afterRetry: await panel.locator('#translation-failures').innerText().catch(() => ''),
      notice: await panel.locator('#notice').innerText().catch(() => ''),
      progress: await panel.locator('#progress-area').innerText().catch(() => ''),
      body: (await panel.locator('body').innerText().catch(() => '')).slice(-3000),
    }, null, 2));
    throw error;
  }

  // Clear disposable translations so the following controls run against a
  // real in-flight task rather than an all-cache fast path.
  await panel.locator('#settings-button').click();
  await panel.locator('#clear-cache').click();
  await panel.locator('#close-settings').click();
  await panel.locator('#restore-page').click();
  await fixture.waitForSelector('[data-deep-research-translation]', { state: 'detached', timeout: 10_000 });

  // Pause leaves any completed overlays in place and allows a cached
  // continuation.
  await panel.locator('#translate-all').click();
  await panel.locator('#pause-translation').waitFor({ state: 'visible', timeout: 10_000 });
  await panel.locator('#pause-translation').click();
  await panel.waitForFunction(() => document.querySelector('#notice')?.textContent?.includes('翻译已暂停'), null, { timeout: 10_000 });
  const pausedVisible = await panel.locator('#cancel-translation').isVisible();
  if (pausedVisible) throw new Error('暂停后取消按钮仍保持处理中状态');

  await panel.locator('#settings-button').click();
  await panel.locator('#clear-cache').click();
  await panel.locator('#close-settings').click();
  await panel.locator('#restore-page').click();
  await fixture.waitForSelector('[data-deep-research-translation]', { state: 'detached', timeout: 10_000 });

  // Cancellation is distinct from restoring the source: it stops future work
  // while leaving already applied results in the page.
  await panel.locator('#translate-all').click();
  await panel.locator('#cancel-translation').waitFor({ state: 'visible', timeout: 10_000 });
  await panel.locator('#cancel-translation').click();
  await panel.waitForFunction(() => document.querySelector('#notice')?.textContent?.includes('翻译已取消'), null, { timeout: 10_000 });
  const preservedAfterCancel = await fixture.locator('[data-deep-research-translation]').count();

  // Selection translation must work for a partial sentence, not only when the
  // selection happens to cover an entire paragraph. The content script keeps
  // the exact Range and renders a short result next to it without replacing
  // source text.
  await fixture.evaluate(() => {
    const node = document.querySelector('#target');
    const text = node?.firstChild;
    if (!node || !text) throw new Error('选段翻译测试缺少目标文本节点');
    const quote = 'Bounded queues keep browser';
    const range = document.createRange();
    range.setStart(text, 0);
    range.setEnd(text, quote.length);
    const selection = window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);
    node.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
  });
  await panel.locator('#selection-section').waitFor({ state: 'visible', timeout: 10_000 });
  await fixture.keyboard.press('Alt+Shift+t');
  await fixture.waitForSelector('[data-deep-research-selection-translation]', { timeout: 30_000 });
  const selectionTranslation = await fixture.evaluate(() => ({
    count: document.querySelectorAll('[data-deep-research-selection-translation]').length,
    source: document.querySelector('#target')?.textContent || '',
    result: document.querySelector('[data-deep-research-selection-translation]')?.textContent || '',
  }));
  if (selectionTranslation.count !== 1 || selectionTranslation.source !== 'Bounded queues keep browser work responsive because cancellation can stop stale requests before they consume more model capacity.' || !selectionTranslation.result) {
    throw new Error(`部分选段翻译没有就近显示：${JSON.stringify(selectionTranslation)}`);
  }
  await panel.locator('#restore-page').click();
  await fixture.waitForSelector('[data-deep-research-selection-translation]', { state: 'detached', timeout: 10_000 });

  // Explicit save -> export -> clear -> import proves that local knowledge is
  // portable while secrets and temporary task inputs stay out of the archive.
  await fixture.evaluate(() => {
    const node = document.querySelector('#target');
    const range = document.createRange();
    range.selectNodeContents(node);
    const selection = window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);
    node.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
  });
  await panel.locator('#selection-section').waitFor({ state: 'visible', timeout: 10_000 });
  await panel.locator('#annotate-selection').click();
  await panel.locator('#annotation-note').fill('可复用的原文标注');
  await panel.locator('#confirm-annotation').click();
  await fixture.waitForSelector('[data-deep-research-annotation-highlight] span', { timeout: 10_000 });
  const annotationState = await fixture.evaluate(() => ({
    hosts: document.querySelectorAll('[data-deep-research-annotation-highlight]').length,
    marks: document.querySelectorAll('[data-deep-research-annotation-highlight] span').length,
  }));
  if (annotationState.hosts !== 1 || annotationState.marks < 1) throw new Error(`标注没有在原文中高亮：${JSON.stringify(annotationState)}`);
  await panel.locator('#save-selection').click();
  await panel.locator('#save-note').fill('可复用的本地阅读判断');
  await panel.locator('#save-ai-answer').fill('队列大小需要结合吞吐和延迟验证。');
  await panel.locator('#confirm-save').click();
  await panel.waitForFunction(() => document.querySelector('#library-list')?.textContent?.includes('Bounded queues'), null, { timeout: 10_000 });

  const downloadPromise = panel.waitForEvent('download');
  await panel.locator('#settings-button').click();
  await panel.locator('#export-data').click();
  const download = await downloadPromise;
  const downloadStream = await download.createReadStream();
  const downloadChunks = [];
  for await (const chunk of downloadStream) downloadChunks.push(chunk);
  const exported = JSON.parse(Buffer.concat(downloadChunks).toString('utf8'));
  if (JSON.stringify(exported).includes('local-test-key') || JSON.stringify(exported).includes('taskInputs')) {
    throw new Error('导出文件包含 API Key 或临时任务输入');
  }
  if (!Array.isArray(exported.annotations) || exported.annotations.length !== 1) {
    throw new Error(`导出文件没有包含标注：${JSON.stringify(Object.keys(exported))}`);
  }
  const savedInsight = exported.insights?.find((item) => item.quote?.startsWith('Bounded queues keep browser'));
  const savedAnchorHash = savedInsight?.anchor?.contentHash || '';
  if (!savedInsight?.document?.version || !savedAnchorHash || savedInsight.document.version !== savedAnchorHash) {
    throw new Error(`收藏没有保存原文版本指纹：${JSON.stringify({ documentVersion: savedInsight?.document?.version, anchorHash: savedAnchorHash })}`);
  }
  panel.once('dialog', (dialog) => dialog.accept());
  await panel.locator('#clear-data').click();
  await panel.waitForFunction(() => !document.querySelector('#library-list')?.textContent?.includes('Bounded queues'), null, { timeout: 10_000 });
  await panel.locator('#import-file').setInputFiles({ name: 'reader-export.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(exported)) });
  await panel.waitForFunction(() => document.querySelector('#library-list')?.textContent?.includes('Bounded queues'), null, { timeout: 10_000 });
  await panel.waitForFunction(() => document.querySelector('#library-list')?.textContent?.includes('可复用的原文标注'), null, { timeout: 10_000 });

  // Reattach the imported annotation, then mutate the source paragraph. The
  // content hash must invalidate the old highlight instead of drawing it on
  // a similar-looking but changed passage.
  await fixture.bringToFront();
  await worker.evaluate(async () => {
    const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    if (tab?.id) await chrome.tabs.sendMessage(tab.id, { type: 'deep-research:request-page' });
  });
  await fixture.waitForSelector('[data-deep-research-annotation-highlight] span', { timeout: 10_000 });
  await fixture.evaluate(() => {
    const target = document.querySelector('#target');
    if (!target) throw new Error('标注漂移测试缺少目标段落');
    target.textContent = `${target.textContent} Changed after the annotation was saved.`;
  });
  await fixture.waitForFunction(() => document.querySelectorAll('[data-deep-research-annotation-highlight]').length === 0, null, { timeout: 10_000 });

  // A borderline visual result must remain a side translation. This exercises
  // the content-script rendering threshold, not only the model parser. The
  // labels must be outside the source image, never over its pixels. The SVG
  // fixture is covered by the preceding image tests.
  const lowConfidenceImageId = await fixture.locator('[data-deep-research-image]').nth(1).getAttribute('data-deep-research-image');
  if (!lowConfidenceImageId) throw new Error('低置信度图片断言缺少图片 ID');
  await worker.evaluate(async ({ imageId }) => {
    const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    if (tab?.id) await chrome.tabs.sendMessage(tab.id, {
      type: 'deep-research:apply-image-translations',
      translations: [{
        id: imageId,
        confidence: 0.5,
        regions: [{ translation: '不可靠覆盖', x: 1, y: 1, width: 10, height: 10 }],
        // A model may return both a whole-image note and a coordinate for a
        // particular OCR region. The coordinate must win so the translation
        // stays next to the source label instead of becoming an unanchored
        // paragraph below the image.
        fallbackText: '保留原图的旁侧译文',
        fallbackRegions: [
          { text: 'tiny', translation: '锚定在原文旁', x: 1, y: 1, width: 10, height: 10 },
          { text: 'middle', translation: '图片外部下方', x: 155, y: 1, width: 10, height: 10 },
        ],
      }],
    });
  }, { imageId: lowConfidenceImageId });
  await fixture.waitForSelector('[data-deep-research-image-side-translations] [data-deep-research-image-side-translation]', { timeout: 10_000 });
  const lowConfidenceState = await fixture.evaluate(() => ({
    overlays: document.querySelectorAll('[data-deep-research-image-overlay]').length,
    fallbacks: document.querySelectorAll('[data-deep-research-image-fallback]').length,
    sideTranslations: document.querySelectorAll('[data-deep-research-image-side-translations] [data-deep-research-image-side-translation]').length,
    imageBottom: document.querySelector('[data-deep-research-image-wrap] img, [data-deep-research-image-wrap] svg')?.getBoundingClientRect().bottom || 0,
    outsideCount: Array.from(document.querySelectorAll('[data-deep-research-image-side-translation]')).filter((node) => {
      const image = node.closest('[data-deep-research-image-wrap]')?.querySelector('img,svg');
      if (!image) return false;
      const label = node.getBoundingClientRect();
      const source = image.getBoundingClientRect();
      return label.top >= source.bottom || label.right <= source.left || label.left >= source.right;
    }).length,
    overlapCount: Array.from(document.querySelectorAll('[data-deep-research-image-side-translation]')).filter((node) => {
      const image = node.closest('[data-deep-research-image-wrap]')?.querySelector('img,svg');
      if (!image) return false;
      const label = node.getBoundingClientRect();
      const source = image.getBoundingClientRect();
      return label.left < source.right && label.right > source.left && label.top < source.bottom && label.bottom > source.top;
    }).length,
  }));
  if (lowConfidenceState.overlays !== 0 || lowConfidenceState.fallbacks !== 0 || lowConfidenceState.sideTranslations !== 2 || lowConfidenceState.outsideCount !== 2 || lowConfidenceState.overlapCount !== 0) throw new Error(`低置信度图片错误覆盖：${JSON.stringify(lowConfidenceState)}`);
  await worker.evaluate(async () => {
    const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    if (tab?.id) await chrome.tabs.sendMessage(tab.id, { type: 'deep-research:restore-translations' });
  });
  await fixture.waitForFunction(() => document.querySelectorAll('[data-deep-research-image-wrap]').length === 0, null, { timeout: 10_000 });

  console.log(JSON.stringify({
    extensionId,
    requestCount,
    paused: true,
    retried: true,
    partialSelectionTranslation: selectionTranslation.count === 1,
    cancelledWithoutImplicitRestore: preservedAfterCancel === 0,
    exportedWithoutSecret: !JSON.stringify(exported).includes('local-test-key'),
    importedInsight: true,
    importedAnnotation: true,
    annotationDriftRejected: true,
    lowConfidenceFallback: true,
    positionedFallbackRegion: true,
  }, null, 2));
} finally {
  await context.close().catch(() => {});
  await new Promise((resolve) => providerServer.close(resolve));
  await new Promise((resolve) => fixtureServer.close(resolve));
}
