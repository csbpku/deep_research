import { existsSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { chromium } from '../../../apps/web/node_modules/@playwright/test/index.mjs';

// Read-only public pages. The harness deliberately does not call a model: it
// verifies that the extension can enter the page, find a bounded reading root,
// preserve code/links, and expose a real text selection without logging body
// content. Translation quality is measured separately with a real provider.
const pages = [
  { kind: 'docs', url: 'https://developer.chrome.com/docs/extensions/develop/concepts/content-scripts' },
  { kind: 'docs', url: 'https://developer.mozilla.org/en-US/docs/Web/API/MutationObserver' },
  { kind: 'docs', url: 'https://react.dev/learn' },
  { kind: 'docs', url: 'https://nodejs.org/api/worker_threads.html' },
  { kind: 'docs', url: 'https://docs.python.org/3/library/asyncio.html' },
  { kind: 'docs', url: 'https://www.postgresql.org/docs/current/index.html' },
  { kind: 'article', url: 'https://stripe.dev/blog/payment-api-design' },
  { kind: 'article', url: 'https://aws.amazon.com/blogs/architecture/exponential-backoff-and-jitter/' },
  { kind: 'article', url: 'https://martinfowler.com/articles/patterns-of-distributed-systems/' },
  { kind: 'article', url: 'https://blog.cloudflare.com/' },
  { kind: 'article', url: 'https://blog.rust-lang.org/' },
  { kind: 'article', url: 'https://engineering.atspotify.com/' },
  { kind: 'github', url: 'https://github.com/microsoft/TypeScript' },
  { kind: 'github', url: 'https://github.com/react/react' },
  { kind: 'github', url: 'https://github.com/denoland/deno' },
  { kind: 'github', url: 'https://github.com/torvalds/linux' },
  { kind: 'github', url: 'https://github.com/Fission-AI/OpenSpec' },
  { kind: 'github', url: 'https://github.com/wxt-dev/wxt' },
  { kind: 'zread', url: 'https://zread.ai/Fission-AI/OpenSpec' },
  { kind: 'zread', url: 'https://zread.ai/microsoft/TypeScript' },
  { kind: 'zread', url: 'https://zread.ai/facebook/react' },
  { kind: 'zread', url: 'https://zread.ai/denoland/deno' },
  { kind: 'zread', url: 'https://zread.ai/torvalds/linux' },
  { kind: 'zread', url: 'https://zread.ai/wxt-dev/wxt' },
];
const selectedPageCandidates = process.env.READER_LIVE_KINDS
  ? pages.filter((page) => process.env.READER_LIVE_KINDS.split(',').map((item) => item.trim()).includes(page.kind))
  : pages;
const liveLimit = Number.parseInt(process.env.READER_LIVE_LIMIT || '', 10);
const selectedPages = Number.isFinite(liveLimit) && liveLimit > 0
  ? selectedPageCandidates.slice(0, liveLimit)
  : selectedPageCandidates;

const extensionPath = new URL('../.output/chrome-mv3', import.meta.url).pathname;
const executablePath = process.env.CHROME_FOR_TESTING
  || [
    '/Users/shaobo.chen/Library/Caches/ms-playwright/chromium-1234/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  ].find(existsSync);
if (!executablePath) throw new Error('找不到 Chrome，请设置 CHROME_FOR_TESTING');

const context = await chromium.launchPersistentContext(`/private/tmp/deep-research-reader-live-${Date.now()}`, {
  executablePath,
  headless: process.env.READER_HEADLESS === '1',
  viewport: { width: 1360, height: 900 },
  // Chrome for Testing can keep extensions disabled unless this explicit
  // switch is present.  The two extension-path switches alone are not
  // sufficient on every local Chrome channel, which makes the worker wait
  // below time out before the first page is visited.
  args: ['--enable-extensions', `--disable-extensions-except=${extensionPath}`, `--load-extension=${extensionPath}`, '--no-first-run', '--no-default-browser-check'],
});

const results = [];
try {
  const serviceWorker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
  const extensionId = new URL(serviceWorker.url()).host;
  const panel = await context.newPage();
  await panel.goto(`chrome-extension://${extensionId}/sidepanel.html`, { waitUntil: 'domcontentloaded' });

  function withTimeout(promise, timeoutMs, label) {
    let timer;
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${label} 超时（${timeoutMs}ms）`)), timeoutMs);
    });
    return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
  }

  // Use the extension page itself for test activation.  Calling
  // chrome.scripting/tabs from the side panel wakes a dormant MV3 worker when
  // needed and avoids retaining a Playwright Worker handle that Chrome has
  // already invalidated between navigations.
  async function activateCurrentPage() {
    return withTimeout(panel.evaluate(async () => {
      const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
      if (!tab?.id) throw new Error('当前标签页不可用');
      await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['content.js'] });
      // The content listener deliberately has no response channel: it emits
      // page context through runtime messages.  Awaiting tabs.sendMessage
      // therefore hangs on Chrome builds that keep the port open.  Script
      // injection is the delivery assertion; the panel wait below asserts the
      // resulting context.
      chrome.tabs.sendMessage(tab.id, { type: 'deep-research:request-page' }).catch(() => {});
      return { tabId: tab.id };
    }), 15_000, '扩展页面激活');
  }

  async function focusCurrentPageAnchor(tabId, quote) {
    return withTimeout(panel.evaluate(async ({ tabId: activeTabId, quote: selectedQuote }) => {
      chrome.tabs.sendMessage(activeTabId, { type: 'deep-research:focus-anchor', anchor: { quote: selectedQuote } }).catch(() => {});
      return true;
    }, { tabId, quote }), 10_000, '引用回跳');
  }

  for (const target of selectedPages) {
    const result = { ...target, ok: false, finalUrl: '', status: null, reason: '' };
    const page = await context.newPage();
    console.log(JSON.stringify({ kind: result.kind, url: result.url, stage: 'start' }));
    try {
      let navigationWarning = '';
      try {
        const response = await page.goto(target.url, { waitUntil: 'commit', timeout: Number(process.env.READER_LIVE_NAV_TIMEOUT_MS || 25_000) });
        result.status = response?.status() ?? null;
      } catch (error) {
        navigationWarning = error instanceof Error ? error.message.split('\n')[0] : '导航超时';
        // Some documentation SPAs keep a connection open indefinitely. If
        // the target URL is already committed and the DOM has a real body,
        // continue with a truthful warning instead of discarding the sample.
        const currentHost = (() => { try { return new URL(page.url()).hostname; } catch { return ''; } })();
        const targetHost = new URL(target.url).hostname;
        if (currentHost !== targetHost) throw error;
      }
      result.finalUrl = page.url();
      await page.waitForTimeout(1_500);
      await withTimeout(page.bringToFront(), 10_000, '页面置前');
      const activation = await activateCurrentPage();
      await panel.waitForFunction(() => {
        const source = document.querySelector('#page-source')?.textContent || '';
        const title = document.querySelector('#page-title')?.textContent || '';
        return Boolean(source && title && !title.includes('打开一个网页后'));
      }, null, { timeout: 15_000 });
      const expectedHost = new URL(result.finalUrl || target.url).hostname;
      await panel.waitForFunction((host) => {
        try { return new URL(document.querySelector('#page-source')?.textContent || '').hostname === host; } catch { return false; }
      }, expectedHost, { timeout: 15_000 });
      const panelState = await panel.evaluate(() => ({
        title: document.querySelector('#page-title')?.textContent || '',
        sourceHost: (() => { try { return new URL(document.querySelector('#page-source')?.textContent || '').hostname; } catch { return ''; } })(),
      }));
      await withTimeout(page.bringToFront(), 10_000, '页面置前');
      const structure = await withTimeout(page.evaluate(() => {
        const candidates = Array.from(document.querySelectorAll('article p, main p, [role="main"] p, #readme p, article li, main li, [role="main"] li, #readme li, h1, h2, h3, h4, blockquote, pre'))
          .filter((node) => (node.innerText || '').trim().length >= 80)
          .slice(0, 3);
        return {
          bodyChars: (document.body?.innerText || '').length,
          codeCount: document.querySelectorAll('pre, code').length,
          linkCount: document.querySelectorAll('a[href]').length,
          imageCount: document.querySelectorAll('article img, main img, [role="main"] img, #readme img').length,
          candidateCount: candidates.length,
          hasReadingSurface: Boolean((document.body?.innerText || '').trim().length >= 200),
        };
      }), 15_000, '正文结构读取');
      let selectionVisible = false;
      let anchorResolved = false;
      let selectedQuote = '';
      if (structure.candidateCount) {
        const selectionData = await withTimeout(page.evaluate(() => {
          const node = Array.from(document.querySelectorAll('article p, main p, [role="main"] p, #readme p, article li, main li, [role="main"] li, #readme li, h1, h2, h3, h4, blockquote, pre'))
            .find((item) => (item.innerText || '').trim().length >= 80);
          if (!node) return { quote: '' };
          const range = document.createRange();
          range.selectNodeContents(node);
          const selection = window.getSelection();
          selection?.removeAllRanges();
          selection?.addRange(range);
          document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
          return { quote: (node.innerText || '').trim() };
        }), 15_000, '选段读取');
        selectedQuote = selectionData.quote || '';
        try {
          await panel.locator('#selection-section').waitFor({ state: 'visible', timeout: 5_000 });
          selectionVisible = true;
        } catch {
          selectionVisible = false;
        }
        if (selectionVisible) {
          selectedQuote = (await panel.locator('#selection-quote').innerText().catch(() => '')) || selectedQuote;
        }
        if (selectedQuote) {
          // Anchor verification uses the exact quote selected in the source
          // page. The resolved event is checked in the side panel; toolbar
          // delivery is measured separately above.
          await focusCurrentPageAnchor(activation.tabId, selectedQuote);
          try {
            // The visual outline is intentionally transient.  The side panel
            // receives the content script's explicit resolved event, which is
            // the durable assertion and does not miss a fast 1.8s highlight.
            await panel.waitForFunction(() => (document.querySelector('#notice')?.textContent || '').includes('已回到原文证据'), null, { timeout: 5_000 });
            anchorResolved = true;
          } catch {
            anchorResolved = false;
          }
        }
      }
      const structurePass = Boolean(panelState.sourceHost && structure.hasReadingSurface && structure.bodyChars >= 200);
      result.ok = structurePass;
      result.reason = structurePass ? '' : '页面已加载但正文上下文未满足验收条件';
      result.navigationWarning = navigationWarning;
      result.selectionWarning = structurePass && structure.candidateCount && !selectionVisible
        ? '正文结构通过；独立扩展标签页面板未稳定收到选段消息，使用原生侧栏时需另行复验。'
        : '';
      result.anchorResolved = anchorResolved;
      result.anchorWarning = selectionVisible && selectedQuote && !anchorResolved
        ? '选段已提取，但引用回跳未在当前页面中确认；不能把它计入定位成功率。'
        : '';
      result.activation = activation;
      result.panel = panelState;
      result.structure = structure;
      result.selectionVisible = selectionVisible;
    } catch (error) {
      result.reason = error instanceof Error ? error.message.slice(0, 240) : '未知失败';
    }
    results.push(result);
    console.log(JSON.stringify({ kind: result.kind, url: result.url, ok: result.ok, status: result.status, reason: result.reason }));
    await page.close().catch(() => {});
  }
  const summary = {
    pages: results.length,
    passed: results.filter((item) => item.ok).length,
    failed: results.filter((item) => !item.ok).length,
    selectionPages: results.filter((item) => item.selectionVisible).length,
    anchorResolved: results.filter((item) => item.anchorResolved).length,
    anchorUnconfirmed: results.filter((item) => item.selectionVisible && !item.anchorResolved).length,
    byKind: Object.fromEntries(['article', 'docs', 'github', 'zread'].map((kind) => [kind, {
      total: results.filter((item) => item.kind === kind).length,
      passed: results.filter((item) => item.kind === kind && item.ok).length,
      anchorResolved: results.filter((item) => item.kind === kind && item.anchorResolved).length,
    }])),
  };
  const output = { generatedAt: new Date().toISOString(), summary, results };
  const outputPath = `/private/tmp/deep-research-reader-live-matrix-${Date.now()}.json`;
  await writeFile(outputPath, JSON.stringify(output, null, 2));
  console.log(JSON.stringify({ summary, outputPath }, null, 2));
} finally {
  await context.close();
}
