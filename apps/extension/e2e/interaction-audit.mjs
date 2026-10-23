import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { cp, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { chromium } from '../../web/node_modules/@playwright/test/index.mjs';
import { join } from 'node:path';
import { tempDir, tempPath } from './temp-paths.mjs';

const artifacts = await mkdtemp(join(tempDir(), 'reader-interaction-audit-'));
const requests = [];
let failTranslations = false;
const source = 'A bounded queue protects memory and gives workers time to finish their current tasks.';
const server = createServer(async (req, res) => {
  res.setHeader('access-control-allow-origin', '*');
  if (req.url === '/article' || req.url === '/other') {
    res.setHeader('content-type', 'text/html');
    res.end(`<html><title>${req.url === '/other' ? 'Other article' : 'Interaction audit'}</title><body><article><h1>Bounded queues</h1><p id="source">${source}</p><p>Cancellation stops stale requests before they consume model capacity.</p><p>Translation and chat should remain independent tasks.</p><svg id="audit-diagram" xmlns="http://www.w3.org/2000/svg" width="360" height="180" role="img" aria-label="Queue diagram"><rect x="40" y="40" width="180" height="80" fill="#edf0ff"/><text x="60" y="85" font-size="22">Queue</text></svg><section class="article-footer"><svg width="162" height="162" viewBox="0 0 162 162"><circle cx="80" cy="80" r="60"/></svg></section><footer><svg width="180" height="100"><rect width="180" height="100"/></svg></footer></article></body></html>`);
    return;
  }
  res.setHeader('content-type', 'application/json');
  if (req.url === '/v1/models') { res.end('{"data":[{"id":"audit-chat"}]}'); return; }
  if (req.url !== '/v1/chat/completions') { res.writeHead(404); res.end('{}'); return; }
  let raw = ''; for await (const chunk of req) raw += chunk;
  const input = JSON.parse(raw || '{}'); requests.push(input);
  const system = String(input.messages?.[0]?.content || '');
  const user = String(input.messages?.at(-1)?.content || '');
  if (failTranslations && system.includes('翻译编辑')) { res.writeHead(400); res.end('{"error":{"message":"audit translation failure"}}'); return; }
  let text = JSON.stringify({ answer: '## Queue safety\n\nA bounded **queue** limits pending work.\n\n- Memory stays bounded.\n- Workers continue.', evidence: [{ quote: source, claim: 'Bounded memory' }], background: '', inference: '', limitations: [] });
  if (system.includes('视觉能力检查器')) text = 'READER_VISION_CHECK';
  else if (system.includes('图片翻译器')) text = JSON.stringify({ regions: [{ text: 'Queue', translation: '队列', x: 60, y: 63, width: 90, height: 30 }], confidence: .95, note: '' });
  else if (system.includes('翻译编辑')) {
    const data = user.split('<<<TRANSLATION_BATCH>>>\n')[1];
    text = data ? JSON.stringify({ translations: JSON.parse(data).blocks.map(b => ({ id: b.id, text: `译文：${b.text}` })) }) : '有界队列可以保护内存。';
  }
  if (system.includes('技术文档翻译器')) text = '有界队列可以保护内存。';
  if (input.stream) {
    res.setHeader('content-type', 'text/event-stream');
    const answerStart = text.indexOf('"answer":"');
    const splitAt = answerStart >= 0 ? text.indexOf('Workers continue') : Math.ceil(text.length / 2);
    const frame = chunk => `data: ${JSON.stringify({ choices: [{ delta: { content: chunk } }] })}\n\n`;
    await new Promise(resolve => setTimeout(resolve, user.includes('Switch test') ? 1600 : 700));
    res.write(frame(text.slice(0, splitAt)));
    await new Promise(resolve => setTimeout(resolve, 600));
    res.write(frame(text.slice(splitAt)));
    await new Promise(resolve => setTimeout(resolve, 120));
    res.end('data: [DONE]\n\n');
  } else {
    await new Promise(resolve => setTimeout(resolve, 700));
    res.end(JSON.stringify({ choices: [{ message: { content: text } }] }));
  }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
const extension = `${artifacts}/extension`;
await cp(new URL('../.output/chrome-mv3', import.meta.url).pathname, extension, { recursive: true });
const manifest = JSON.parse(await readFile(`${extension}/manifest.json`, 'utf8'));
manifest.host_permissions = ['http://127.0.0.1/*'];
await writeFile(`${extension}/manifest.json`, JSON.stringify(manifest));
const context = await chromium.launchPersistentContext(`${artifacts}/profile`, {
  executablePath: process.env.CHROME_FOR_TESTING || '/Users/shaobo.chen/Library/Caches/ms-playwright/chromium-1234/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing',
  headless: true, locale: 'zh-CN', viewport: { width: 360, height: 720 },
  args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`],
});
const checks = [];
const errors = [];
let page;
async function checkMaterialSurface(surface) {
  const report = await page.evaluate(() => {
    const visible = element => { const s = getComputedStyle(element); const r = element.getBoundingClientRect(); return s.display !== 'none' && s.visibility !== 'hidden' && r.width > 0 && r.height > 0; };
    return {
      buttons: [...document.querySelectorAll('button')].filter(visible).filter(el => !el.classList.contains('MuiButtonBase-root')).map(el => el.id || el.innerText),
      fields: [...document.querySelectorAll('input,textarea,select')].filter(visible).filter(el => el.type !== 'file' && !el.closest('.MuiInputBase-root')).map(el => el.id),
      fonts: [...document.querySelectorAll('button,input,textarea,select')].filter(visible).filter(el => getComputedStyle(el).fontFamily !== getComputedStyle(document.body).fontFamily).map(el => el.id),
    };
  });
  assert.deepEqual(report, { buttons: [], fields: [], fonts: [] }, `${surface}: visible controls use actual MUI components and the shared font`);
}
async function checkNavigationLayout(language, surface) {
  for (const width of [320, 360, 420, 529, 705]) {
    await page.setViewportSize({ width, height: 720 });
    const buttons = await page.locator('.workspace-nav-item').evaluateAll(elements => elements.map(el => {
      const rect = el.getBoundingClientRect();
      const style = getComputedStyle(el);
      const label = el.querySelector('span');
      return { x: rect.x, right: rect.right, width: rect.width, height: rect.height, padding: style.paddingLeft,
        labelVisible: getComputedStyle(label).display !== 'none', clipped: el.scrollWidth > el.clientWidth + 1 };
    }));
    assert.equal(buttons.length, 4);
    assert.equal(await page.locator('.mark').evaluate(el => el.getBoundingClientRect().width), 32, 'readable Reader mark');
    for (const [index, button] of buttons.entries()) {
      assert.ok(button.height >= 44, `${language} ${surface} ${width}px: navigation target height`);
      assert.ok(button.width >= 44 && button.width < 100, `${language} ${surface} ${width}px: compact labelled targets`);
      assert.equal(button.padding, '8px', 'MUI reset must not remove navigation padding');
      assert.equal(button.labelVisible, true, 'keep visible labels in narrow sidebars');
      assert.equal(button.clipped, false, `${language} ${surface} ${width}px: label fits`);
      assert.ok(button.x >= 0 && button.right <= width, 'navigation fits viewport');
      if (index) assert.ok(Math.abs(button.x - buttons[index - 1].right - 4) < 1, 'consistent 4px gaps');
    }
  }
  await page.setViewportSize({ width: 360, height: 720 });
}
async function checkModeCardLayout(language) {
  for (const width of [320, 360, 705]) {
    await page.setViewportSize({ width, height: 720 });
    const cards = await page.locator('.mode-option').evaluateAll(elements => elements.map(el => {
      const title = el.querySelector('strong').getBoundingClientRect();
      const description = el.querySelector('.mode-option-content > span').getBoundingClientRect();
      return { height: el.getBoundingClientRect().height, titleBottom: title.bottom, descriptionTop: description.top,
        clipped: el.scrollWidth > el.clientWidth + 1, check: getComputedStyle(el.querySelector('.mode-option-check')).visibility,
        selected: el.getAttribute('aria-pressed') === 'true' };
    }));
    for (const card of cards) {
      assert.ok(card.descriptionTop >= card.titleBottom + 3, `${language} ${width}px: description below mode title`);
      assert.ok(card.height >= 88 && !card.clipped, 'mode cards wrap without clipping');
      assert.equal(card.check === 'visible', card.selected, 'selected mode has a check beyond its color');
    }
  }
  await page.setViewportSize({ width: 360, height: 720 });
}
try {
  const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
  const id = new URL(worker.url()).host;
  const article = await context.newPage(); await article.goto(`${origin}/article`);
  page = await context.newPage();
  page.on('pageerror', error => errors.push(error.message));
  await page.addInitScript(() => {
    window.__readerCspViolations = [];
    document.addEventListener('securitypolicyviolation', event => {
      window.__readerCspViolations.push({ directive: event.effectiveDirective, blocked: event.blockedURI });
    });
  });
  await page.goto(`chrome-extension://${id}/sidepanel.html`);
  await page.waitForFunction(() => document.documentElement.dataset.readerReady === 'true');
  await checkNavigationLayout('zh-CN', 'chat');
  checks.push('顶部四入口在 320–705px 按内容紧凑排列、4px 间隔、44px 点击高度和 32px 标识，中英文均保留标签');
  const materialSurface = await page.evaluate(() => ({
    primary: getComputedStyle(document.documentElement).getPropertyValue('--reader-color-primary').trim(),
    font: getComputedStyle(document.body).fontFamily,
    emotionStyles: document.querySelectorAll('style[data-emotion]').length,
    sendButton: document.querySelector('#send-question')?.classList.contains('MuiButton-root'),
    composerInput: document.querySelector('#question-input')?.classList.contains('MuiInputBase-input'),
    containedRadius: getComputedStyle(document.querySelector('#save-settings')).borderRadius,
    containedBackground: getComputedStyle(document.querySelector('#save-settings')).backgroundColor,
    outlinedFieldRadius: getComputedStyle(document.querySelector('#provider-key')?.closest('.MuiOutlinedInput-root')).borderRadius,
    composerRadius: getComputedStyle(document.querySelector('#persistent-composer')).borderRadius,
  }));
  assert.equal(materialSurface.primary, '#405c9d', 'the extension page should expose the shared design-system palette');
  assert.match(materialSurface.font, /system-ui/i, 'chat and settings should use the shared font stack');
  assert.ok(materialSurface.emotionStyles > 0, 'MUI Emotion styles should mount under the extension CSP');
  assert.equal(materialSurface.sendButton, true, 'chat actions should be rendered by MUI');
  assert.equal(materialSurface.composerInput, true, 'the composer textarea should retain its DOM identity inside MUI');
  assert.equal(materialSurface.containedRadius, '8px', 'MUI buttons should use the shared compact control radius instead of the old pill override');
  assert.equal(materialSurface.containedBackground, 'rgb(64, 92, 157)', 'contained MUI buttons should use the shared primary color');
  assert.equal(materialSurface.outlinedFieldRadius, '8px', 'MUI form fields should use the shared control radius');
  assert.equal(materialSurface.composerRadius, '12px', 'the MUI composer surface should use the shared card radius');
  assert.equal(await page.locator('#continue-answer').count(), 0, '回答下方不应重复提供聚焦输入框的追问按钮');
  assert.match(await page.locator('body').evaluate(el => getComputedStyle(el).fontFamily), /system-ui/i, '聊天应使用统一的阅读字体栈');
  const composerFocus = await page.locator('#question-input').evaluate(el => ({ outline: getComputedStyle(el).outlineStyle, width: getComputedStyle(el).outlineWidth }));
  assert.equal(composerFocus.outline, 'none', '鼠标点击输入框不应出现突兀的蓝色外框');
  await article.bringToFront();
  await worker.evaluate(async () => {
    const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['content.js'] });
    await chrome.tabs.sendMessage(tab.id, { type: 'deep-research:request-page' });
  });
  await page.locator('#page-view').waitFor({ state: 'visible' });
  const extractedImages = await worker.evaluate(async () => {
    const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { chrome.runtime.onMessage.removeListener(receive); reject(new Error('Full document image extraction timed out')); }, 10000);
      function receive(message, sender) {
        const payload = message.type === 'deep-research:from-page' ? message.payload : message;
        if (payload?.type !== 'deep-research:full-document' || sender.tab?.id !== tab.id) return;
        clearTimeout(timer); chrome.runtime.onMessage.removeListener(receive);
        resolve({ candidates: payload.context.imageCandidateCount, items: payload.context.images.map(image => image.alt) });
      }
      chrome.runtime.onMessage.addListener(receive);
      chrome.tabs.sendMessage(tab.id, { type: 'deep-research:request-full-document' }).catch(error => { clearTimeout(timer); chrome.runtime.onMessage.removeListener(receive); reject(error); });
    });
  });
  assert.deepEqual(extractedImages, { candidates: 1, items: ['Queue diagram'] }, 'Keep article diagrams while excluding decorative images in semantic and article footers');
  checks.push('正文技术图保留，footer 和 article-footer 中的大型装饰 SVG 不进入模型翻译');
  await page.locator('#settings-button').click();
  await checkModeCardLayout('zh-CN');
  await checkMaterialSurface('settings');
  await page.screenshot({ path: `${artifacts}/settings-zh-360.png` });
  for (const selector of ['#manual-model-settings', '.provider-extra-checks']) {
    const disclosure = page.locator(selector);
    const summary = disclosure.locator('.MuiAccordionSummary-root');
    await summary.scrollIntoViewIfNeeded();
    const geometry = await summary.evaluate(el => {
      const row = el.getBoundingClientRect(); const icon = el.querySelector('svg').getBoundingClientRect();
      return { height: row.height, iconSize: icon.width, iconRight: icon.right, rowRight: row.right, offset: Math.abs(icon.y + icon.height / 2 - row.y - row.height / 2) };
    });
    assert.ok(geometry.height >= 44 && geometry.iconSize >= 20 && geometry.offset < 1 && geometry.iconRight <= geometry.rowRight, 'disclosures have a visible, aligned 20px indicator and a 44px target');
    assert.equal(await summary.getAttribute('aria-expanded'), 'false');
    await summary.click();
    assert.equal(await summary.getAttribute('aria-expanded'), 'true');
    await disclosure.locator('.MuiAccordionDetails-root input, .MuiAccordionDetails-root button').first().waitFor({ state: 'visible' });
    await summary.press('Enter');
    assert.equal(await summary.getAttribute('aria-expanded'), 'false');
  }
  await page.locator('.provider-extra-checks').scrollIntoViewIfNeeded();
  await page.screenshot({ path: `${artifacts}/settings-disclosures.png` });
  checks.push('设置折叠项具有20px箭头、44px整行点击目标，点击展开及键盘收起正常');
  assert.equal(await page.locator('#provider-key').evaluate(el => el.classList.contains('MuiOutlinedInput-input')), true, 'provider settings should use the shared MUI form field');
  await page.locator('#provider-kind').selectOption('local-proxy', { force: true });
  await page.locator('#provider-url').fill(`${origin}/v1`);
  await page.locator('#provider-model-list option[value="audit-chat"]').waitFor({ state: 'attached' });
  await page.locator('#provider-model-list').selectOption('audit-chat');
  await page.locator('#save-settings').click();
  await page.locator('#settings-notice').filter({ hasText: '已保存' }).waitFor();
  await page.locator('#close-settings').click();
  const heightOfInput = () => page.locator('#question-input').evaluate(el => el.getBoundingClientRect().height);
  await page.locator('#composer-resize').press('Home');
  const compactHeight = await heightOfInput();
  await page.locator('#composer-resize').press('End');
  assert.ok(await heightOfInput() > compactHeight + 100, 'keyboard expands the actual composer');
  await page.locator('#composer-resize').press('Home');
  assert.ok(await heightOfInput() < compactHeight + 2, 'keyboard shrinks the actual composer');
  const grip = await page.locator('#composer-resize').boundingBox();
  await page.mouse.move(grip.x + grip.width / 2, grip.y + grip.height / 2);
  await page.mouse.down(); await page.mouse.move(grip.x + grip.width / 2, grip.y - 100, { steps: 8 }); await page.mouse.up();
  assert.ok(await heightOfInput() > compactHeight + 70, 'drag expands the actual composer');
  await page.locator('#composer-resize').press('Home');
  await page.locator('#question-input').fill('Long draft. '.repeat(120));
  assert.ok(await heightOfInput() < compactHeight + 2, 'long input respects manual compact size');
  await page.locator('#composer-size-toggle').click();
  assert.ok(await heightOfInput() > compactHeight + 100);
  await page.locator('#composer-size-toggle').click();
  assert.ok(await heightOfInput() < compactHeight + 2);
  assert.equal(await page.locator('#question-input').inputValue(), 'Long draft. '.repeat(120));
  await page.locator('#question-input').fill('');
  checks.push('输入区真实几何高度随拖动、键盘扩大和缩小');
  for (const width of [320, 360, 705]) {
    await page.setViewportSize({ width, height: 720 });
    const geometry = await page.locator('#composer-model').evaluate(el => {
      const row = el.closest('.composer-context-row').getBoundingClientRect(); const button = el.getBoundingClientRect();
      const label = el.querySelector('#composer-model-label').getBoundingClientRect(); const icon = el.querySelector('svg').getBoundingClientRect();
      return { iconSize: icon.width, centered: Math.abs(label.y + label.height / 2 - icon.y - icon.height / 2), rightGap: row.right - button.right, fits: icon.right <= button.right && icon.x >= label.right };
    });
    assert.equal(geometry.iconSize, 20); assert.ok(geometry.centered < 1 && geometry.fits && Math.abs(geometry.rightGap) < 1, 'model selector stays at the right with a centered, reserved arrow');
  }
  await page.setViewportSize({ width: 360, height: 720 });
  await page.locator('#composer-model').click();
  assert.equal(await page.locator('#composer-model').getAttribute('aria-expanded'), 'true');
  await page.locator('#composer-model-search').fill('no-matching-model');
  assert.equal(await page.locator('.composer-model-option').count(), 0);
  assert.equal(await page.locator('#composer-model-status').innerText(), '没有匹配的模型。');
  await page.locator('#composer-model-search').fill('audit');
  await page.locator('#composer-model-search').press('ArrowDown');
  await page.locator('.composer-model-option').first().waitFor();
  assert.equal(await page.locator('.composer-model-option').first().evaluate(el => el === document.activeElement), true);
  await page.locator('.composer-model-option').first().press('Enter');
  await page.locator('#composer-model-menu').waitFor({ state: 'hidden' });
  await page.locator('#composer-model').click();
  await page.locator('#composer-model-search').press('Escape');
  assert.equal(await page.locator('#composer-model').getAttribute('aria-expanded'), 'false');
  assert.equal(await page.locator('#composer-model svg').count(), 1, 'model refreshes keep the SVG indicator');
  checks.push('模型选择箭头在320–705px居中且保留独立空间，菜单展开/收起后仍保留');
  const menuAction = async selector => {
    if (selector === '#chat-translate') await page.locator('#scope-page').click();
    await page.locator(selector).click();
  };
  const selection = async () => {
    await article.locator('#source').evaluate(el => {
      const range = document.createRange(); range.selectNodeContents(el);
      const s = getSelection(); s.removeAllRanges(); s.addRange(range);
      el.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
    });
    await page.locator('#scope-selection').waitFor({ state: 'visible' });
  };
  const data = () => worker.evaluate(async () => {
    const db = await new Promise((resolve, reject) => {
      const request = indexedDB.open('deep-research-reader');
      request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error);
    });
    try {
      const values = await Promise.all(['insights', 'annotations'].map(name => new Promise((resolve, reject) => {
        const request = db.transaction(name).objectStore(name).getAll();
        request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error);
      })));
      return { insights: values[0], annotations: values[1] };
    } finally { db.close(); }
  });

  await page.locator('#question-input').fill('   ');
  assert.equal(await page.locator('#send-question').isDisabled(), true);
  await page.locator('#question-input').fill('Explain the queue.');
  await page.locator('#question-input').press('Shift+Enter');
  assert.match(await page.locator('#question-input').inputValue(), /\n/);
  assert.equal(requests.length, 0);
  await page.locator('#question-input').press('Control+Enter');
  await page.locator('#conversation-list').filter({ hasText: 'limits pending work' }).waitFor();
  assert.equal(requests.length, 1);
  checks.push('空白禁发、Shift+Enter 换行、Ctrl+Enter 发送');

  await selection();
  const quoteStyle = await page.locator('#chat-selection-quote').evaluate(el => ({
    color: getComputedStyle(el).color,
    background: getComputedStyle(el).backgroundColor,
  }));
  assert.notEqual(quoteStyle.color, 'rgb(255, 255, 255)', '选段预览文字应使用可读的深色');
  assert.notEqual(quoteStyle.background, 'rgb(49, 89, 201)', '选段预览不应使用遮字的纯蓝底色');
  assert.equal(await page.locator('#chat-tools-menu').count(), 0, '预设问题不再包装为工具菜单');
  assert.deepEqual(await page.locator('.composer-tools > button').allTextContents(), ['总结', '翻译', '中文']);
  for (const selector of ['#copy-chat-selection', '#annotate-selection', '#save-selection']) {
    assert.equal(await page.locator(selector).isVisible(), true, '选段操作应直接出现在原文预览旁');
  }
  await page.screenshot({ path: `${artifacts}/selection-context-actions.png` });
  await page.locator('#question-input').fill('解释当前选段');
  await page.locator('#send-question').click();
  await page.locator('#pending-turn').waitFor({ state: 'visible' });
  assert.match(await page.locator('#pending-turn').innerText(), /解释当前选段/);
  assert.match(await page.locator('#answer-progress-text').innerText(), /正在读取所选原文|正在核对原文依据/);
  await page.screenshot({ path: `${artifacts}/selection-pending-turn.png` });
  await article.waitForFunction(() => !window.getSelection()?.toString());
  await page.waitForFunction(() => document.querySelector('#answer-output')?.textContent?.includes('A bounded'));
  assert.equal(await page.locator('#answer-output h4').count(), 1, '流式阶段就应渲染标题');
  assert.equal(await page.locator('#answer-output strong').innerText(), 'queue', '流式阶段就应渲染粗体');
  assert.ok(await page.locator('#answer-output li').count() > 0, '流式阶段就应渲染列表');
  assert.doesNotMatch(await page.locator('#answer-output').innerText(), /##|\*\*|"answer"/, '不显示 Markdown 或 JSON 控制符');
  assert.equal(await page.locator('#send-question').isVisible(), false, '生成期间同位置显示停止按钮');
  assert.equal(await page.locator('#stop-answer svg').count(), 1);
  const stopBox = await page.locator('#stop-answer').boundingBox();
  assert.equal(stopBox.width, 40); assert.equal(stopBox.height, 40);
  assert.equal(await page.locator('#pending-turn').isVisible(), true, '首段回答流出时，处理中对话行应保持可见');
  assert.equal(await page.locator('#answer-progress-text').innerText(), '正在生成回答…');
  await page.screenshot({ path: `${artifacts}/selection-streaming-answer.png` });
  await page.locator('#conversation-list').filter({ hasText: 'A bounded queue limits pending work.' }).waitFor();
  await page.locator('#pending-turn').waitFor({ state: 'hidden' });
  assert.equal(await page.locator('#conversation-list > article').count(), 4, '当前聊天保留此前所有轮次');
  assert.equal((await data()).insights.length, 0, '问答不会自动创建收藏');
  assert.equal(await page.locator('#translation-language').count(), 0, '聊天输入区不再提供语言下拉');
  assert.equal(requests.length, 2);
  checks.push('移除综合工具箱、选段操作就地展示、发送即显示处理中状态并清除网页选区高亮');

  await selection();
  await page.locator('#toggle-chat-selection').click();
  assert.equal(await page.locator('#chat-selection-card').evaluate(el => el.classList.contains('expanded')), true);
  assert.match(await page.locator('#chat-selection-card').innerText(), /bounded queue/);
  await page.locator('#clear-chat-selection').click();
  assert.equal(await page.locator('#scope-page').getAttribute('aria-pressed'), 'true');
  await article.waitForFunction(() => !window.getSelection()?.toString() && !document.querySelector('[data-deep-research-toolbar]'));
  checks.push('选段预览展开、清除选段和范围切换');

  await selection();
  await menuAction('#save-selection');
  await page.locator('#save-quote').fill('');
  await page.locator('#confirm-save').click();
  await page.locator('#save-notice').filter({ hasText: '原文摘录' }).waitFor();
  await page.locator('#save-quote').fill(source);
  await page.locator('#save-note').fill('audit note');
  await page.locator('#confirm-save').dblclick();
  await page.locator('#save-dialog').waitFor({ state: 'hidden' });
  assert.equal((await data()).insights.length, 1, '快速连点保存只能创建一张收藏卡');
  checks.push('收藏必填校验与连点防重复');

  await selection();
  await menuAction('#annotate-selection');
  assert.equal(await page.locator('#annotation-note').evaluate(el => el === document.activeElement), true);
  await page.locator('#annotation-note').fill('audit annotation');
  await page.locator('#confirm-annotation').dblclick();
  await page.locator('#annotation-dialog').waitFor({ state: 'hidden' });
  assert.equal((await data()).annotations.length, 1, '快速连点标注只能创建一条标注');
  await article.locator('[data-deep-research-annotation-highlight] span').first().waitFor();
  checks.push('标注自动聚焦、连点防重复和原文高亮');

  await page.locator('#settings-button').click();
  await page.locator('#import-file').setInputFiles({ name: 'invalid.json', mimeType: 'application/json', buffer: Buffer.from('{"version":999}') });
  await page.locator('#settings-notice').filter({ hasText: '版本不受支持' }).waitFor();
  assert.equal(await page.locator('#import-file').inputValue(), '', '导入结束应重置文件框，允许重选同名文件');
  const exported = await data();
  assert.equal(JSON.stringify(exported).includes('apiKey'), false);
  const downloadPromise = page.waitForEvent('download');
  await page.locator('#export-data').click();
  const download = await downloadPromise; await download.saveAs(`${artifacts}/export.json`);
  const exportedFile = JSON.parse(await readFile(`${artifacts}/export.json`, 'utf8'));
  assert.equal(exportedFile.insights.length, 1); assert.equal(exportedFile.annotations.length, 1);
  page.once('dialog', d => d.dismiss()); await page.locator('#clear-data').click();
  assert.equal((await data()).insights.length, 1);
  page.once('dialog', d => d.accept()); await page.locator('#clear-data').click();
  await page.locator('#settings-notice').filter({ hasText: '数据已清除' }).waitFor();
  assert.equal((await data()).insights.length, 0);
  await page.locator('#import-file').setInputFiles(`${artifacts}/export.json`);
  await page.locator('#settings-notice').filter({ hasText: '数据已导入' }).waitFor();
  assert.equal((await data()).insights.length, 1); assert.equal((await data()).annotations.length, 1);
  checks.push('无效导入反馈、重复选文件、导出、取消清空和导入恢复');

  await page.locator('#close-settings').click();
  await menuAction('#chat-translate');
  for (let i = 0; i < 60 && !requests.some(r => String(r.messages?.[0]?.content).includes('翻译编辑')); i++) await new Promise(resolve => setTimeout(resolve, 50));
  assert.ok(requests.some(r => String(r.messages?.[0]?.content).includes('翻译编辑')), '暂停测试必须等待真实翻译请求开始');
  await page.locator('#pause-translation').waitFor();
  await page.locator('#pause-translation').click();
  await page.locator('#notice').filter({ hasText: '已暂停' }).waitFor();
  await page.waitForTimeout(400);
  assert.equal(await page.locator('#pause-translation').isVisible(), true, '暂停完成后继续按钮应持续可见');
  await page.locator('#pause-translation').click();
  await article.locator('[data-deep-research-translation-for]').first().waitFor();
  await page.waitForFunction(() => document.querySelector('#notice').textContent.includes('全文翻译完成'));
  const translatedParagraph = article.locator('[data-deep-research-translation-for]').first();
  assert.equal(await translatedParagraph.evaluate(el => getComputedStyle(el).borderInlineStartWidth), '0px', '正文译文不应带蓝色左侧竖条');
  await translatedParagraph.hover();
  const paragraphControl = article.locator('[data-deep-research-paragraph-control]');
  await paragraphControl.waitFor({ state: 'visible' });
  const pageControlTheme = await paragraphControl.evaluate(el => ({
    token: getComputedStyle(el).getPropertyValue('--reader-color-primary').trim(),
    buttonColor: getComputedStyle(el.shadowRoot.querySelector('button')).color,
    buttonFont: getComputedStyle(el.shadowRoot.querySelector('button')).fontFamily,
    buttonRadius: getComputedStyle(el.shadowRoot.querySelector('button')).borderRadius,
  }));
  assert.equal(pageControlTheme.token, '#405c9d', 'webpage Shadow DOM controls should inherit the same design tokens');
  assert.equal(pageControlTheme.buttonColor, 'rgb(64, 92, 157)', 'webpage controls should use the shared primary color');
  assert.match(pageControlTheme.buttonFont, /system-ui/i, 'webpage controls should use the same font stack');
  assert.equal(pageControlTheme.buttonRadius, '8px', 'webpage controls should share the MUI button radius through design tokens');
  const clickParagraphControl = async () => {
    const point = await paragraphControl.evaluate(el => {
      const rect = el.shadowRoot.querySelector('button').getBoundingClientRect();
      return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
    });
    await article.mouse.move(point.x, point.y);
    await article.waitForTimeout(350);
    assert.equal(await paragraphControl.isVisible(), true, '指针从译文移到原文按钮后，控件应保持可点击');
    await article.mouse.click(point.x, point.y);
  };
  await clickParagraphControl();
  const highlighted = article.locator('[data-deep-research-paragraph-highlight][data-selected="true"]');
  assert.equal(await highlighted.isVisible(), true, '切换后标示当前选中的段落');
  const selectedId = await highlighted.getAttribute('data-paragraph-id');
  await article.mouse.move(2, 2);
  await article.waitForTimeout(350);
  assert.equal(await highlighted.isVisible(), true, '移开鼠标仍保留当前切换段落的定位效果');
  assert.equal(await highlighted.getAttribute('data-paragraph-id'), selectedId);
  await article.waitForFunction(() => {
    const translated = document.querySelector('[data-deep-research-translation-for]');
    const original = translated?.previousElementSibling;
    return translated?.style.display === 'none' && original && getComputedStyle(original).display !== 'none';
  });
  assert.match(await paragraphControl.evaluate(el => el.shadowRoot.querySelector('button').textContent), /查看这一段译文/);
  await clickParagraphControl();
  await article.waitForFunction(() => document.querySelector('[data-deep-research-translation-for]')?.style.display !== 'none');
  await worker.evaluate(() => chrome.storage.local.set({ readerUiLanguage: 'en' }));
  await paragraphControl.locator('button').filter({ hasText: 'Show paragraph source' }).waitFor();
  // The dock labels are translated in place, so the English label must
  // become a visible button again. Use the computed accessibility tree
  // instead of the raw CDP tree, which does not map shadow-DOM controls to
  // a `button` role on every Chromium build.
  const englishDockAction = article.getByRole('button', { name: 'Summarize article', exact: true });
  assert.equal(await englishDockAction.count(), 1, 'existing webpage dock switches UI language');
  assert.ok(await englishDockAction.isVisible(), 'existing webpage dock stays visible in English');
  await worker.evaluate(() => chrome.storage.local.set({ readerUiLanguage: 'zh-CN' }));
  await paragraphControl.locator('button').filter({ hasText: '查看这一段原文' }).waitFor();
  assert.equal(await page.locator('#return-answer').count(), 0, 'source locating belongs to specific citations');
  await page.locator('#answer-evidence-list .evidence-item').first().click();
  await page.locator('#notice').filter({ hasText: '已回到原文证据' }).waitFor();
  await article.waitForFunction(() => {
    const translated = [...document.querySelectorAll('[data-deep-research-translation-for]')]
      .find(node => node.previousElementSibling?.textContent?.includes('A bounded queue protects memory'));
    const original = translated?.previousElementSibling;
    return original && translated.style.display === 'none' && getComputedStyle(original).display !== 'none';
  });
  checks.push('Material 字体与焦点状态、译文无蓝色侧条、段落按钮可稳定点击、聊天证据定位显示原文');
  const imageControl = article.locator('[data-deep-research-image-control]').first();
  await imageControl.locator('button[data-action="toggle"]').click();
  await imageControl.locator('button[data-action="toggle"]').click();
  await imageControl.locator('button[data-action="zoom"]').click();
  await article.locator('[data-deep-research-image-zoom]').waitFor();
  await article.keyboard.press('Escape');
  await article.locator('[data-deep-research-image-zoom]').waitFor({ state: 'detached' });
  checks.push('图片翻译切换、查看大图和 Escape 关闭');
  await menuAction('#restore-page');
  await article.locator('[data-deep-research-translation-for]').waitFor({ state: 'detached' });
  await page.locator('#translation-summary').waitFor({ state: 'hidden' });
  checks.push('翻译暂停、继续和恢复原文，任务控制随状态显示与收起');

  await page.locator('#settings-button').click(); await page.locator('#clear-cache').click(); await page.locator('#close-settings').click();
  await menuAction('#chat-translate');
  await page.locator('#cancel-translation').click();
  await page.locator('#notice').filter({ hasText: '已取消' }).waitFor();
  await page.locator('#translation-summary').waitFor({ state: 'hidden' });
  failTranslations = true;
  await menuAction('#chat-translate');
  await page.locator('#translation-summary[data-state="error"]').waitFor();
  assert.equal(await page.locator('#translation-details').getAttribute('open'), '', '失败项应直接在任务卡中展开');
  await page.screenshot({ path: `${artifacts}/translation-retry-entry.png` });
  await page.locator('.translation-retry').first().waitFor();
  await page.screenshot({ path: `${artifacts}/translation-retry-items.png` });
  const failedCount = await page.locator('.translation-retry').count();
  failTranslations = false;
  await page.locator('.translation-retry').first().click();
  await page.waitForFunction(count => document.querySelectorAll('.translation-retry').length < count, failedCount);
  await article.locator('[data-deep-research-translation-for]').first().waitFor();
  await menuAction('#restore-page');
  checks.push('翻译取消反馈与失败项单独重试');

  await page.locator('#nav-library').click();
  assert.equal(await page.locator('#library-list .session-row').count(), 0, '收藏页不应混入自动阅读历史');
  await page.locator('#library-list').filter({ hasText: source }).waitFor();
  await page.locator('#library-list [data-action="edit"]').first().click();
  assert.equal(await page.locator('#save-note').inputValue(), 'audit note');
  await page.locator('#cancel-save').click();
  await page.locator('#nav-chat').click();
  assert.equal(new URL(page.url()).searchParams.has('view'), false, '切回聊天同步移除收藏页深链参数');
  await page.locator('#question-input').fill('Keep this draft.');
  await page.locator('#open-history-header').click();
  await page.locator('#history-tabs[aria-busy="false"]').waitFor();
  assert.equal(await page.locator('#close-history').evaluate(el => el.classList.contains('MuiButtonBase-root')), true, 'history navigation should use the shared MUI components');
  const historyControl = await page.locator('#export-history').evaluate(el => ({
    mui: el.classList.contains('MuiButton-root'),
    radius: getComputedStyle(el).borderRadius,
    font: getComputedStyle(el).fontFamily,
  }));
  assert.equal(historyControl.mui, true, 'history actions should use MUI buttons');
  assert.equal(historyControl.radius, '8px', 'history buttons should share the same MUI control radius');
  assert.match(historyControl.font, /system-ui/i, 'history should use the shared MUI typography');
  assert.equal(await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--reader-color-primary').trim()), '#405c9d', 'history should load the same design tokens');
  await page.locator('#history-search-input').fill('not-found-unique-audit');
  assert.equal(await page.locator('.history-card').count(), 0);
  await page.locator('#history-search-input').fill('Interaction audit');
  const card = page.locator('.history-card').first(); await card.waitFor();
  await checkMaterialSurface('history records');
  await card.locator('.history-card-source').evaluate(el => { el.textContent += `/${'long-source-path/'.repeat(40)}`; });
  for (const width of [320, 360, 674]) {
    await page.setViewportSize({ width, height: 720 });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, `history with long source URLs stays within ${width}px`);
  }
  await page.setViewportSize({ width: 360, height: 720 });
  await card.getByRole('button', { name: '更多记录操作' }).click();
  page.once('dialog', d => d.accept('Audit renamed chat'));
  await page.getByRole('menuitem', { name: '重命名', exact: true }).click();
  await page.locator('#history-search-input').fill('Audit renamed chat');
  await page.locator('.history-card').filter({ hasText: 'Audit renamed chat' }).waitFor();
  await page.locator('#close-history').click();
  await page.locator('#question-input').waitFor();
  assert.equal(await page.locator('#question-input').inputValue(), 'Keep this draft.');
  checks.push('收藏导航、历史搜索与重命名、返回保留草稿');

  const readCurrentArticle = async () => {
    await worker.evaluate(async currentOrigin => {
      const [tab] = await chrome.tabs.query({ url: `${currentOrigin}/*` });
      await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['content.js'] });
      await chrome.tabs.sendMessage(tab.id, { type: 'deep-research:request-page' });
    }, origin);
  };
  await readCurrentArticle();
  await page.locator('#conversation-list > article').nth(3).waitFor();
  await page.locator('#question-input').fill('Switch test: explain the queue.');
  await page.locator('#send-question').click();
  await page.locator('#pending-turn').waitFor();
  assert.equal(await page.locator('#question-input').inputValue(), '', '已发送的问题立即离开输入草稿');
  await article.goto(`${origin}/other`); await readCurrentArticle();
  await page.locator('#discussion-source-title').filter({ hasText: 'Other article' }).waitFor();
  assert.equal(await page.locator('#stop-answer').isVisible(), false, '切页后旧任务不占用新页面输入');
  await page.locator('#question-input').fill('Explain this other article.');
  await page.locator('#send-question').click();
  await page.locator('#pending-turn').waitFor({ state: 'hidden' });
  assert.equal(await page.locator('#conversation-list > article').count(), 2, '其他文章的聊天独立显示');
  await page.waitForTimeout(1200);
  assert.doesNotMatch(await page.locator('#notice').textContent(), /上一篇文章/);
  await article.goto(`${origin}/article`); await readCurrentArticle();
  await page.waitForFunction(() => document.querySelectorAll('#conversation-list > article').length === 6);
  assert.equal(await page.locator('#question-input').inputValue(), '', '返回文章不恢复已发送的问题');
  await page.reload();
  await page.waitForFunction(() => document.documentElement.dataset.readerReady === 'true');
  await readCurrentArticle();
  await page.waitForFunction(() => document.querySelectorAll('#conversation-list > article').length === 6);
  assert.equal(await page.locator('#question-input').inputValue(), '', '刷新侧栏不恢复已发送的问题');
  assert.equal(await page.locator('.shell').getAttribute('data-workspace-view'), 'chat', '重开侧栏默认进入聊天');
  checks.push('回答期间切换文章、并行回答隔离、后台完成不弹旧文提示、回访及刷新保留所有轮次');

  const savedDeepLink = new URL(page.url()); savedDeepLink.searchParams.set('view', 'library');
  await page.goto(savedDeepLink.href);
  await page.waitForFunction(() => document.documentElement.dataset.readerReady === 'true');
  assert.equal(await page.locator('.shell').getAttribute('data-workspace-view'), 'library');
  await page.locator('#nav-chat').click();
  assert.equal(new URL(page.url()).searchParams.has('view'), false, '离开收藏深链后重载应停留在聊天');
  await page.locator('#settings-button').click();
  await page.locator('#interface-language').selectOption('en');
  await page.waitForFunction(() => document.documentElement.lang === 'en' && document.documentElement.dataset.readerReady === 'true');
  await readCurrentArticle();
  assert.equal(await page.locator('.shell').getAttribute('data-workspace-view'), 'chat', '更换界面语言不跳回收藏');
  assert.equal(await page.locator('#nav-chat').getAttribute('aria-label'), 'Chat');
  assert.equal(await page.locator('#nav-library').getAttribute('aria-label'), 'Saved');
  await checkNavigationLayout('en', 'chat');
  await page.locator('#settings-button').click();
  await checkModeCardLayout('en');
  await page.screenshot({ path: `${artifacts}/settings-en-360.png` });
  await page.locator('#close-settings').click();
  assert.deepEqual(await page.locator('.composer-tools > button').allTextContents(), ['Summarize', 'Translate', 'EN']);
  assert.equal(await page.locator('#conversation-list > article').count(), 6, '切换界面语言不改变历史内容');
  await page.setViewportSize({ width: 320, height: 720 });
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth > innerWidth);
  assert.equal(overflow, false, '英文侧栏不应横向溢出');
  await page.screenshot({ path: `${artifacts}/chat-en-320.png` });
  await page.locator('#open-history-header').click();
  await page.locator('#history-tabs[aria-busy="false"]').waitFor();
  await checkNavigationLayout('en', 'history');
  await page.setViewportSize({ width: 320, height: 720 });
  assert.equal(await page.locator('#history-section-title').innerText(), 'Chats');
  await page.screenshot({ path: `${artifacts}/history-en-320.png` });
  await page.locator('#close-history').click();
  await page.waitForFunction(() => document.documentElement.dataset.readerReady === 'true');
  await readCurrentArticle();
  assert.ok(requests.filter(item => item.messages?.[0]?.content?.includes('latest user question')).length >= 3, '回答语言策略跟随用户提问');
  checks.push('中英文界面切换、英文窄侧栏及历史页、聊天无语言下拉、问答语言策略');
  checks.push('设置、历史记录与聊天中的可见按钮全部为真实 MUI，所有可见表单字段属于 MUI InputBase，字体一致');
  assert.deepEqual(errors, []);
  assert.deepEqual(await page.evaluate(() => window.__readerCspViolations), [], 'MUI style injection must not violate the extension CSP');
  await checkMaterialSurface('chat and generated answer');
  await page.locator('#discussion-followups').waitFor({ state: 'visible' });
  const followupGaps = await page.locator('.discussion-followup').evaluateAll(elements => elements.slice(1).map((el, index) => el.getBoundingClientRect().top - elements[index].getBoundingClientRect().bottom));
  assert.ok(followupGaps.length > 0 && followupGaps.every(gap => gap >= 8), 'followup suggestions keep the shared 8px spacing');
  assert.equal(await page.locator('#discussion-followups').evaluate(el => getComputedStyle(el).borderTopWidth), '1px', 'followup suggestions have one shared frame');
  const followupRows = await page.locator('.discussion-followup').evaluateAll(elements => elements.map(el => ({ border: getComputedStyle(el).borderTopWidth, height: el.getBoundingClientRect().height, icon: Boolean(el.querySelector('svg')) })));
  assert.ok(followupRows.every(row => row.border === '0px' && row.height >= 44 && row.icon), 'suggested questions use borderless, clearly clickable rows inside the group');
  const actions = await page.locator('#answer-actions').evaluate(el => {
    const copy = el.querySelector('#copy-answer'); const save = el.querySelector('#save-answer');
    return { copyBackground: getComputedStyle(copy).backgroundColor, saveBackground: getComputedStyle(save).backgroundColor,
      icons: el.querySelectorAll('button svg').length, beforeEvidence: Boolean(el.compareDocumentPosition(document.querySelector('#answer-structured')) & Node.DOCUMENT_POSITION_FOLLOWING) };
  });
  assert.equal(await page.locator('.conversation-copy').first().evaluate(el => getComputedStyle(el).borderTopWidth), '1px', 'earlier answers use the same outlined Copy treatment');
  assert.notEqual(actions.copyBackground, actions.saveBackground, 'copy and save have distinct treatments');
  assert.equal(actions.icons, 2, 'labelled action icons'); assert.equal(actions.beforeEvidence, true, 'answer actions precede supplemental evidence');
  await page.locator('#answer-actions').scrollIntoViewIfNeeded();
  await page.screenshot({ path: `${artifacts}/answer-actions-en.png` });
  await page.screenshot({ path: `${artifacts}/final-chat.png` });
  await page.locator('#discussion-followups').scrollIntoViewIfNeeded();
  await page.screenshot({ path: `${artifacts}/followup-group.png` });
  const followupText = await page.locator('.discussion-followup').first().innerText();
  const messageCount = await page.locator('#conversation-list > article').count();
  await page.locator('.discussion-followup').first().click();
  await page.waitForFunction(count => document.querySelectorAll('#conversation-list > article').length === count + 2, messageCount);
  assert.equal(await page.locator('#conversation-list > article.user').last().innerText(), followupText);
  checks.push('追问建议只有一个分组边框，问题为无边框44px点击行，点击后正常生成新一轮对话');
  await writeFile(`${artifacts}/report.json`, JSON.stringify({ version: manifest.version, checks, errors, artifacts }, null, 2));
  console.log(JSON.stringify({ pass: true, version: manifest.version, checks, artifacts }, null, 2));
} catch (error) {
  if (page) await page.screenshot({ path: `${artifacts}/failure.png` }).catch(() => {});
  console.error(JSON.stringify({ artifacts, checks, errors })); throw error;
} finally { await context.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
