import { createServer } from 'node:http';
import { cp, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { chromium } from '../../../apps/web/node_modules/@playwright/test/index.mjs';

const fixturePath = new URL('./fixture.html', import.meta.url);
const port = 8891;
const server = createServer(async (request, response) => {
  if (request.url === '/fixture.html') {
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    response.end(await readFile(fixturePath));
    return;
  }
  response.writeHead(404);
  response.end('not found');
});
await new Promise((resolve, reject) => {
  server.once('error', reject);
  server.listen(port, '127.0.0.1', resolve);
});

const extensionPath = new URL('../.output/chrome-mv3', import.meta.url).pathname;
const testExtensionRoot = await mkdtemp('/private/tmp/deep-research-reader-visual-extension-');
const testExtensionPath = `${testExtensionRoot}/extension`;
await cp(extensionPath, testExtensionPath, { recursive: true });
const testManifestPath = `${testExtensionPath}/manifest.json`;
const testManifest = JSON.parse(await readFile(testManifestPath, 'utf8'));
testManifest.host_permissions = [...new Set([...(testManifest.host_permissions || []), 'http://127.0.0.1/*'])];
await writeFile(testManifestPath, JSON.stringify(testManifest));
const executablePath = process.env.CHROME_FOR_TESTING
  || [
    '/Users/shaobo.chen/Library/Caches/ms-playwright/chromium-1234/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  ].find(existsSync);
if (!executablePath) throw new Error('找不到 Chrome，请设置 CHROME_FOR_TESTING');

const context = await chromium.launchPersistentContext(`/private/tmp/deep-research-reader-visual-${Date.now()}`, {
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

async function layoutReport(page, name) {
  const report = await page.evaluate((stateName) => {
    const visible = (element) => {
      const style = getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      return style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 0 && rect.height > 0;
    };
    const clippedControls = [...document.querySelectorAll('button,input,select,textarea')]
      .filter(visible)
      .flatMap((element) => {
        const rect = element.getBoundingClientRect();
        const horizontalClip = rect.left < -0.5 || rect.right > innerWidth + 0.5;
        const textClip = element instanceof HTMLButtonElement
          && (element.scrollWidth > element.clientWidth + 1 || element.scrollHeight > element.clientHeight + 1);
        return horizontalClip || textClip
          ? [{ id: element.id || element.textContent?.trim() || element.tagName, rect: { left: rect.left, right: rect.right, width: rect.width }, horizontalClip, textClip }]
          : [];
      });
    const controls = [...document.querySelectorAll('button,input,select,textarea')].filter(visible);
    const smallTargets = controls.flatMap((element) => {
      const hitTarget = element instanceof HTMLInputElement
        && ['checkbox', 'radio'].includes(element.type)
        && element.labels?.length
        ? element.labels[0]
        : element;
      const rect = hitTarget.getBoundingClientRect();
      return rect.width < 24 || rect.height < 24
        ? [{ id: element.id || element.textContent?.trim() || element.tagName, width: rect.width, height: rect.height }]
        : [];
    });
    const unlabeledControls = controls.flatMap((element) => {
      const associatedLabel = 'labels' in element
        ? [...(element.labels || [])].map((labelElement) => labelElement.innerText).join(' ')
        : '';
      const labelledBy = element.getAttribute('aria-labelledby')
        ?.split(/\s+/u).map((id) => document.getElementById(id)?.innerText || '').join(' ');
      const label = element.getAttribute('aria-label') || labelledBy || element.getAttribute('title')
        || associatedLabel
        || element.textContent || element.getAttribute('placeholder') || '';
      return !String(label).trim()
        ? [{ id: element.id || element.tagName, tag: element.tagName, type: element.getAttribute('type') }]
        : [];
    });
    return {
      state: stateName,
      viewport: { width: innerWidth, height: innerHeight },
      documentWidth: document.documentElement.scrollWidth,
      bodyWidth: document.body.scrollWidth,
      overflowX: document.documentElement.scrollWidth > innerWidth + 1 || document.body.scrollWidth > innerWidth + 1,
      clippedControls,
      smallTargets,
      unlabeledControls,
    };
  }, name);
  if (report.overflowX || report.clippedControls.length > 0 || report.smallTargets.length > 0 || report.unlabeledControls.length > 0) {
    throw new Error(`visual layout assertion failed: ${JSON.stringify(report)}`);
  }
  return report;
}

try {
  const serviceWorker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
  const extensionId = new URL(serviceWorker.url()).host;
  const article = await context.newPage();
  await article.goto(`http://127.0.0.1:${port}/fixture.html`, { waitUntil: 'domcontentloaded' });
  await article.bringToFront();
  await serviceWorker.evaluate(async () => {
    const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    if (!tab?.id) throw new Error('fixture tab is not active');
    await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['content.js'] });
    await chrome.tabs.sendMessage(tab.id, { type: 'deep-research:request-page' });
  });
  await article.waitForSelector('[data-deep-research-dock]', { timeout: 10_000 });
  await article.screenshot({ path: '/private/tmp/deep-research-reader-right-dock.png' });
  const accessibilitySession = await context.newCDPSession(article);
  const { nodes: accessibilityNodes } = await accessibilitySession.send('Accessibility.getFullAXTree');
  const dockActions = accessibilityNodes
    .filter((node) => ['总结本页', '翻译本页'].includes(node.name?.value))
    .map((node) => ({ label: node.name.value, role: node.role?.value }));
  for (const label of ['总结本页', '翻译本页']) {
    if (!dockActions.some((item) => item.label === label && item.role === 'button')) {
      throw new Error(`right dock ${label} action is missing from the browser accessibility tree: ${JSON.stringify(dockActions)}`);
    }
  }

  const panel = await context.newPage();
  await panel.goto(`chrome-extension://${extensionId}/sidepanel.html`, { waitUntil: 'domcontentloaded' });
  await panel.waitForFunction(() => document.documentElement.dataset.readerReady === 'true', null, { timeout: 10_000 });
  for (const [field, expectedLabel] of [['question-input', '继续提问'], ['save-quote', '原文摘录']]) {
    const actualLabel = await panel.locator(`label[for="${field}"]`).innerText();
    if (actualLabel !== expectedLabel) throw new Error(`${field} accessible label is missing or incorrect: ${actualLabel}`);
  }
  if (await panel.locator('#progress-area [role="progressbar"]').count() !== 2) {
    throw new Error('text and image translation progress must both expose progressbar semantics');
  }
  if (await panel.locator('#notice').getAttribute('aria-live') !== 'polite'
    || await panel.locator('#reader-status-strip').getAttribute('role') !== 'status') {
    throw new Error('reader status feedback is missing an accessible live status role');
  }

  const dockBounds = await article.locator('[data-deep-research-dock]').boundingBox();
  if (!dockBounds) throw new Error('right dock has no clickable bounds');
  await article.bringToFront();
  await article.mouse.click(dockBounds.x + dockBounds.width - 27, dockBounds.y + 22);
  try {
    await panel.waitForFunction(() => document.querySelector('#mode-guidance')?.textContent?.includes('全文总结尚未开始'), null, { timeout: 10_000 });
  } catch (error) {
    const diagnostic = await panel.evaluate(async () => ({
      settingsVisible: !document.querySelector('#settings-view')?.classList.contains('hidden'),
      guidance: document.querySelector('#mode-guidance')?.textContent || '',
      notice: document.querySelector('#notice')?.textContent || '',
      status: document.querySelector('#page-context-status')?.textContent || '',
      pageTitle: document.querySelector('#page-title')?.textContent || '',
      tokenPresent: Boolean((await chrome.storage.local.get(['readerToken'])).readerToken),
    }));
    const workerState = await serviceWorker.evaluate(async () => ({
      pending: (await chrome.storage.session.get('readerPendingPageAction')).readerPendingPageAction || null,
      contexts: Object.entries(await chrome.storage.session.get(null))
        .filter(([key]) => key.startsWith('readerContext:'))
        .map(([key, value]) => ({ key, url: value?.context?.url || null, bodyChars: value?.context?.body?.length || 0 })),
      tabs: (await chrome.tabs.query({})).map(({ id, url, active, windowId }) => ({ id, url, active, windowId })),
    }));
    throw new Error(`summary action did not show setup guidance: ${JSON.stringify({ diagnostic, workerState })}; ${error.message}`);
  }
  const summaryGuidance = await panel.locator('#mode-guidance').innerText();
  if (!summaryGuidance.includes('全文总结尚未开始') || !summaryGuidance.includes('模型服务')) {
    throw new Error(`dock summary click did not explain local model setup: ${summaryGuidance}`);
  }
  await panel.locator('#close-settings').click();
  const localAvailability = await panel.locator('#ai-availability-banner').innerText();
  if (!localAvailability.includes('独立模式尚未配置模型') || await panel.locator('#ai-availability-action').innerText() !== '配置模型') {
    throw new Error(`独立模式缺少明确的模型配置提示：${localAvailability}`);
  }

  await article.bringToFront();
  await article.mouse.click(dockBounds.x + dockBounds.width - 27, dockBounds.y + 63);
  await panel.waitForFunction(() => document.querySelector('#mode-guidance')?.textContent?.includes('全文翻译尚未开始'), null, { timeout: 10_000 });
  const translationGuidance = await panel.locator('#mode-guidance').innerText();
  if (!translationGuidance.includes('全文翻译尚未开始') || !translationGuidance.includes('模型服务')) {
    throw new Error(`dock translation click did not explain local model setup: ${translationGuidance}`);
  }
  await panel.locator('#close-settings').click();

  await panel.setViewportSize({ width: 320, height: 820 });
  await panel.locator('#settings-button').click();
  await panel.screenshot({ path: '/private/tmp/deep-research-reader-settings-local-320.png', fullPage: true });
  const local320 = await layoutReport(panel, 'settings-local-320');
  if (!(await panel.locator('#local-provider-settings').isVisible()) || await panel.locator('#platform-settings').isVisible()) {
    throw new Error('独立模式设置应只显示本地模型服务。');
  }
  const permissionLabel = await panel.locator('#request-provider-origin').evaluate((element) => ({
    text: [...element.labels].map((label) => label.innerText).join(' ').trim(),
    height: element.labels[0]?.getBoundingClientRect().height || 0,
    checked: element.checked,
  }));
  if (!permissionLabel.text.includes('保存时请求访问该模型服务域名') || permissionLabel.height < 24) {
    throw new Error(`模型域名权限复选框没有完整的可点标签：${JSON.stringify(permissionLabel)}`);
  }
  await panel.locator('#request-provider-origin').focus();
  await panel.keyboard.press('Space');
  if (await panel.locator('#request-provider-origin').isChecked() === permissionLabel.checked) {
    throw new Error('模型域名权限复选框不能通过键盘空格切换。');
  }
  await panel.keyboard.press('Space');
  if (await panel.locator('#request-provider-origin').isChecked() !== permissionLabel.checked) {
    throw new Error('恢复权限复选框原值失败。');
  }

  await panel.setViewportSize({ width: 360, height: 820 });
  await panel.locator('#mode-platform').click();
  await panel.screenshot({ path: '/private/tmp/deep-research-reader-settings-platform-360.png', fullPage: true });
  const platform360 = await layoutReport(panel, 'settings-platform-360');
  if (await panel.locator('#local-provider-settings').isVisible() || !(await panel.locator('#platform-settings').isVisible())) {
    throw new Error('平台模式设置应只显示连接调研平台。');
  }
  const platformModeNote = await panel.locator('#mode-data-note').innerText();
  if (!platformModeNote.includes('平台模式') || !platformModeNote.includes('调研平台 AI Engine')) {
    throw new Error(`平台模式说明没有反映平台 AI Engine 数据路径：${platformModeNote}`);
  }
  await panel.locator('#close-settings').click();
  const platformAvailability = await panel.locator('#ai-availability-banner').innerText();
  if (!platformAvailability.includes('平台模式尚未连接') || await panel.locator('#ai-availability-action').innerText() !== '连接平台') {
    throw new Error(`平台模式缺少明确的连接提示：${platformAvailability}`);
  }
  await panel.locator('#settings-button').click();
  await panel.locator('#mode-local').click();
  if (!(await panel.locator('#local-provider-settings').isVisible()) || await panel.locator('#platform-settings').isVisible()) {
    throw new Error('切回独立模式后应只显示本地模型服务。');
  }
  const localModeNote = await panel.locator('#mode-data-note').innerText();
  if (!localModeNote.includes('独立模式') || !localModeNote.includes('保存在本地')) {
    throw new Error(`独立模式说明没有反映本地数据路径：${localModeNote}`);
  }

  await panel.locator('#close-settings').click();
  const sidepanelTextActionHeights = await panel.locator('button.text-button').evaluateAll((buttons) => buttons
    .filter((button) => button.getBoundingClientRect().width > 0 && button.getBoundingClientRect().height > 0)
    .map((button) => button.getBoundingClientRect().height));
  if (sidepanelTextActionHeights.some((height) => height < 32)) {
    throw new Error(`sidepanel text actions have undersized hit areas: ${sidepanelTextActionHeights}`);
  }
  await article.bringToFront();
  await serviceWorker.evaluate(async () => {
    const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    if (!tab?.id) throw new Error('article tab is not active before page-context refresh');
    await chrome.tabs.sendMessage(tab.id, { type: 'deep-research:request-page' });
  });
  await panel.waitForFunction(() => document.querySelector('#page-context-status')?.textContent === '正文已读取', null, { timeout: 10_000 });
  await article.evaluate(() => {
    const node = document.querySelector('#target');
    if (!node) throw new Error('fixture target paragraph is missing');
    const range = document.createRange();
    range.selectNodeContents(node);
    const selection = window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);
    node.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
  });
  await panel.waitForFunction(() => Boolean(document.querySelector('#selection-quote')?.textContent), null, { timeout: 10_000 });
  await panel.setViewportSize({ width: 420, height: 820 });
  await panel.screenshot({ path: '/private/tmp/deep-research-reader-article-420.png', fullPage: true });
  const article420 = await layoutReport(panel, 'article-selection-420');

  if (await panel.locator('#ask-page').count() !== 0 || await panel.locator('.selection-action-label').innerText() !== '选段操作') {
    throw new Error('选段工具仍重复展示聊天范围/整页提问入口。');
  }
  await panel.locator('#annotate-selection').click();
  await panel.locator('#annotation-dialog').waitFor({ state: 'visible', timeout: 5_000 });
  await panel.locator('#annotation-note').fill('E2E annotation note');
  await panel.locator('#confirm-annotation').click();
  await panel.getByText('标注已保存，并已在原文高亮。').waitFor({ state: 'visible', timeout: 10_000 });
  const annotationHighlight = await article.waitForFunction(() => {
    const target = document.querySelector('#target')?.getBoundingClientRect();
    const marks = [...document.querySelectorAll('[data-deep-research-annotation-highlight] > span')];
    const mark = marks.find((element) => {
      const rect = element.getBoundingClientRect();
      return target && rect.width > 0 && rect.height > 0
        && rect.left < target.right && rect.right > target.left
        && rect.top < target.bottom && rect.bottom > target.top;
    });
    if (!mark) return false;
    return {
      count: marks.length,
      background: getComputedStyle(mark).backgroundColor,
      withinTarget: true,
    };
  }, null, { timeout: 10_000 }).then((handle) => handle.jsonValue());
  if (!annotationHighlight.withinTarget || !annotationHighlight.background.includes('255, 213, 72')) {
    throw new Error(`saved annotation did not highlight the selected source text: ${JSON.stringify(annotationHighlight)}`);
  }
  await article.screenshot({ path: '/private/tmp/deep-research-reader-annotation-highlight.png', fullPage: true });

  await panel.locator('#save-selection').click();
  await panel.locator('#save-dialog').waitFor({ state: 'visible', timeout: 5_000 });
  const excerptCopy = await panel.locator('#save-mode-note').innerText();
  if (!excerptCopy.includes('不会在原文添加高亮') || !excerptCopy.includes('阅读结论卡')) {
    throw new Error(`excerpt action does not explain its distinction from an annotation: ${excerptCopy}`);
  }
  await panel.locator('#cancel-save').click();

  await panel.locator('#ask-selection').click();
  await panel.locator('#discussion-section').waitFor({ state: 'visible', timeout: 5_000 });
  await panel.locator('#question-input').waitFor({ state: 'visible', timeout: 5_000 });
  await panel.screenshot({ path: '/private/tmp/deep-research-reader-chat-420.png', fullPage: true });
  await panel.screenshot({ path: '/private/tmp/deep-research-reader-chat-420-viewport.png' });
  const chatLayout = await panel.locator('#discussion-section').evaluate((section) => {
    const surface = section.querySelector('.chat-window');
    const transcript = section.querySelector('.chat-transcript')?.getBoundingClientRect();
      const composer = section.querySelector('#persistent-composer');
      const composerRect = composer?.getBoundingClientRect();
      const surfaceRect = surface?.getBoundingClientRect();
      const pageViewRect = document.querySelector('#page-view')?.getBoundingClientRect();
      const emptyState = section.querySelector('.conversation-empty')?.getBoundingClientRect();
      const transcriptRect = transcript;
      return {
        visible: Boolean(composer && getComputedStyle(composer).display !== 'none' && composerRect?.height),
        position: composer ? getComputedStyle(composer).position : 'missing',
        composerBottom: composerRect?.bottom ?? null,
        inSession: Boolean(surface && composer && surface.contains(composer)),
        transcriptAboveComposer: Boolean(transcript && composerRect && transcript.bottom <= composerRect.top + 1),
        withinSession: Boolean(surfaceRect && composerRect && composerRect.bottom <= surfaceRect.bottom + 1),
        pinnedToPanelBottom: Boolean(pageViewRect && composerRect && Math.abs(pageViewRect.bottom - composerRect.bottom) < 2),
        emptyStateCentered: Boolean(emptyState && transcriptRect
          && Math.abs((emptyState.top + emptyState.bottom) / 2 - (transcriptRect.top + transcriptRect.bottom) / 2) < 24),
      };
    });
  if (!chatLayout.visible || !chatLayout.inSession || !chatLayout.transcriptAboveComposer || !chatLayout.withinSession || !chatLayout.pinnedToPanelBottom || !chatLayout.emptyStateCentered || chatLayout.position === 'fixed') {
    throw new Error(`chat history and input are not arranged in one session container: ${JSON.stringify(chatLayout)}`);
  }
  await panel.locator('#page-overview-scroll').evaluate((element) => { element.scrollTop = element.scrollHeight; });
  const composerAfterOverviewScroll = await panel.locator('#persistent-composer').evaluate((element) => element.getBoundingClientRect().bottom);
  if (Math.abs(composerAfterOverviewScroll - chatLayout.composerBottom) > 1) {
    throw new Error('chat composer moved when the reading overview scrolled');
  }

  const dock = await article.locator('[data-deep-research-dock]').evaluate((element) => {
    const rect = element.getBoundingClientRect();
    return {
      rightGap: innerWidth - rect.right,
      top: rect.top,
      width: rect.width,
      withinViewport: rect.left >= 0 && rect.right <= innerWidth && rect.top >= 0 && rect.bottom <= innerHeight,
    };
  });
  if (!dock.withinViewport || dock.rightGap < -0.5) throw new Error(`right dock is outside the viewport: ${JSON.stringify(dock)}`);

  await panel.setViewportSize({ width: 320, height: 820 });
  await panel.locator('#open-history-header').click();
  await panel.waitForURL(`chrome-extension://${extensionId}/reading-history.html?surface=sidepanel`);
  await panel.screenshot({ path: '/private/tmp/deep-research-reader-history-320.png', fullPage: true });
  const history320 = await layoutReport(panel, 'history-320');
  const historyBackTop = await panel.locator('#close-history').evaluate((element) => element.getBoundingClientRect().top);
  if (historyBackTop > 100) throw new Error('history back action is not in the header');
  const historyActionHeights = await panel.locator('.history-header-actions button').evaluateAll((buttons) => buttons.map((button) => button.getBoundingClientRect().height));
  if (historyActionHeights.some((height) => height > 42)) throw new Error(`history header actions wrap at 320px: ${historyActionHeights}`);
  const historyCardActionHeights = await panel.locator('.history-card-actions button').evaluateAll((buttons) => buttons.map((button) => button.getBoundingClientRect().height));
  if (historyCardActionHeights.length === 0 || historyCardActionHeights.some((height) => height < 32)) {
    throw new Error(`history card actions are missing or have undersized hit areas: ${historyCardActionHeights}`);
  }
  await panel.locator('body').evaluate((element) => { element.tabIndex = -1; element.focus(); });
  await panel.keyboard.press('Tab');
  const firstHistoryFocus = await panel.evaluate(() => ({
    id: document.activeElement?.id,
    outlineStyle: getComputedStyle(document.activeElement).outlineStyle,
    outlineWidth: getComputedStyle(document.activeElement).outlineWidth,
  }));
  if (firstHistoryFocus.id !== 'close-history' || firstHistoryFocus.outlineStyle === 'none' || parseFloat(firstHistoryFocus.outlineWidth) < 2) {
    throw new Error(`history keyboard focus is not visible on the first action: ${JSON.stringify(firstHistoryFocus)}`);
  }
  await panel.keyboard.press('Tab');
  if (await panel.evaluate(() => document.activeElement?.id) !== 'export-history') {
    throw new Error('history header keyboard order does not follow the visual order');
  }
  await panel.locator('#close-history').click();
  await panel.waitForURL(`chrome-extension://${extensionId}/sidepanel.html`);

  console.log(JSON.stringify({
    ok: true,
    extensionId,
    states: [local320, platform360, article420, history320],
    chatLayout,
    dockActions,
    annotationHighlight,
    excerptCopy,
    sidepanelTextActionHeights,
    historyCardActionHeights,
    dock,
    screenshots: [
      '/private/tmp/deep-research-reader-right-dock.png',
      '/private/tmp/deep-research-reader-settings-local-320.png',
      '/private/tmp/deep-research-reader-settings-platform-360.png',
      '/private/tmp/deep-research-reader-article-420.png',
      '/private/tmp/deep-research-reader-annotation-highlight.png',
      '/private/tmp/deep-research-reader-chat-420.png',
      '/private/tmp/deep-research-reader-chat-420-viewport.png',
      '/private/tmp/deep-research-reader-history-320.png',
    ],
  }, null, 2));
} finally {
  await context.close();
  await new Promise((resolve) => server.close(resolve));
}
