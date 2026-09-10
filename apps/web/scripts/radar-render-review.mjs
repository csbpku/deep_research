#!/usr/bin/env node

import { chromium } from '@playwright/test';

const argv = process.argv.slice(2);
function arg(name, fallback = '') {
  const index = argv.indexOf(name);
  return index >= 0 ? argv[index + 1] ?? fallback : fallback;
}

const summaryId = arg('--summary-id');
const round = Number(arg('--round', '1'));
const baseUrl = arg('--base-url', process.env.RADAR_RENDER_REVIEW_BASE_URL ?? 'http://127.0.0.1:3000');

if (!summaryId) {
  console.error('Missing --summary-id');
  process.exit(2);
}

const viewports = [
  { name: 'desktop', width: 1440, height: 1000 },
  { name: 'mobile', width: 390, height: 844 },
];

function finding(code, severity, message, evidence = null) {
  return { code, severity, message, evidence };
}

function isIgnorableFailedRequest(request) {
  const url = request.url();
  return url.startsWith('data:') || url.startsWith('blob:') || url.includes('/favicon');
}

async function inspectViewport(browser, viewport) {
  const context = await browser.newContext({ viewport: { width: viewport.width, height: viewport.height } });
  const page = await context.newPage();
  const consoleErrors = [];
  const pageErrors = [];
  const failedRequests = [];
  const badResponses = [];

  page.on('console', (message) => {
    if (message.type() === 'error') {
      consoleErrors.push(message.text().slice(0, 500));
    }
  });
  page.on('pageerror', (error) => {
    pageErrors.push(String(error).slice(0, 500));
  });
  page.on('requestfailed', (request) => {
    if (!isIgnorableFailedRequest(request)) {
      failedRequests.push({
        url: request.url().slice(0, 500),
        error: request.failure()?.errorText ?? 'request_failed',
      });
    }
  });
  page.on('response', (response) => {
    if (response.status() >= 400 && !response.url().includes('/favicon')) {
      badResponses.push({
        url: response.url().slice(0, 500),
        status: response.status(),
      });
    }
  });

  const target = `${baseUrl.replace(/\/$/u, '')}/radar/${summaryId}?renderReview=1`;
  let httpStatus = null;
  let navigationError = null;
  try {
    const response = await page.goto(target, {
      waitUntil: 'domcontentloaded',
      timeout: 30_000,
    });
    httpStatus = response?.status() ?? null;
    await page.waitForTimeout(1_500);
    await page.waitForFunction(
      () => {
        const main = document.querySelector('main');
        if (!main) return false;
        const text = main.innerText?.trim() ?? '';
        return text.length > 160 || Boolean(document.querySelector('[data-testid="radar-detail-intro"]'));
      },
      { timeout: 12_000 },
    ).catch(() => undefined);
    // The reading surface uses a real scroll owner. Move both possible owners
    // so lazy article blocks and lazy images are evaluated, too.
    await page.evaluate(() => {
      for (const element of document.querySelectorAll('main, [data-radar-reading-root]')) {
        const node = /** @type {HTMLElement} */ (element);
        node.scrollTop = node.scrollHeight;
      }
      window.scrollTo(0, document.body.scrollHeight);
    });
    await page.waitForTimeout(600);
  } catch (error) {
    navigationError = String(error).slice(0, 500);
  }

  const diagnostics = await page.evaluate(() => {
    const main = document.querySelector('main');
    const mainText = main?.innerText?.trim() ?? '';
    const bodyText = document.body?.innerText?.trim() ?? '';
    const mobile = window.innerWidth <= 640;
    const style = (element) => window.getComputedStyle(element);
    const rect = (element) => {
      const value = element.getBoundingClientRect();
      return { top: value.top, bottom: value.bottom, width: value.width, height: value.height };
    };
    const isVisible = (element) => {
      const value = rect(element);
      const computed = style(element);
      return value.width > 0
        && value.height > 0
        && computed.display !== 'none'
        && computed.visibility !== 'hidden'
        && computed.opacity !== '0';
    };
    const scrollableAncestor = (element) => {
      let current = element.parentElement;
      while (current) {
        const computed = style(current);
        if (current.scrollWidth > current.clientWidth + 4 && /(auto|scroll)/u.test(computed.overflowX)) {
          return current;
        }
        current = current.parentElement;
      }
      return null;
    };

    const images = [...document.querySelectorAll('main img')].map((image) => ({
      src: image.currentSrc || image.getAttribute('src') || '',
      complete: image.complete,
      naturalWidth: image.naturalWidth,
      alt: image.getAttribute('alt') || '',
    }));
    const tables = [...document.querySelectorAll('main table')].map((table) => ({
      width: Math.round(table.getBoundingClientRect().width),
      scrollWidth: table.scrollWidth,
      viewportWidth: window.innerWidth,
      wrapped: Boolean(scrollableAncestor(table)),
    }));
    const readerBlocks = [...document.querySelectorAll('[data-radar-block="true"]')];
    const renderedReaderBlocks = readerBlocks.filter((block) => block.innerText.trim().length > 0);
    const intro = document.querySelector('[data-testid="radar-detail-intro"]');
    const firstBlock = readerBlocks[0];
    const firstBlockRect = firstBlock ? rect(firstBlock) : null;
    const visibleMathml = [...document.querySelectorAll('main .katex-mathml')].filter((element) => {
      const computed = style(element);
      const value = rect(element);
      return value.width > 0
        && value.height > 0
        && computed.display !== 'none'
        && computed.visibility !== 'hidden'
        && computed.clip !== 'rect(0px, 0px, 0px, 0px)';
    }).length;
    const skeletonText = [...document.querySelectorAll('[role="status"], [aria-busy="true"]')]
      .map((element) => element.textContent || '')
      .join(' ');

    return {
      url: window.location.href,
      mainTextChars: mainText.length,
      bodyTextChars: bodyText.length,
      horizontalOverflow: document.documentElement.scrollWidth > window.innerWidth + 2
        || Boolean(main && main.scrollWidth > main.clientWidth + 2),
      images,
      tables,
      readerBlockCount: readerBlocks.length,
      renderedReaderBlockCount: renderedReaderBlocks.length,
      visibleMathml,
      mermaidError: /Syntax error in text|Mermaid.*error/iu.test(bodyText)
        || Boolean(document.querySelector('[data-mermaid-error], .mermaid-error')),
      skeletonText: skeletonText.slice(0, 300),
      introPresent: Boolean(intro),
      introVisible: Boolean(intro && isVisible(intro)),
      firstBlockTop: firstBlockRect?.top ?? null,
      mobileContentBelowFold: mobile
        && Boolean(firstBlockRect)
        && (firstBlockRect.top ?? 0) > window.innerHeight * 1.8,
      signInRedirect: window.location.pathname.startsWith('/signin'),
    };
  }).catch((error) => ({
    evaluateError: String(error).slice(0, 500),
  }));

  const findings = [];
  if (navigationError) {
    findings.push(finding('navigation_failed', 'blocking', '详情页无法完成真实浏览器导航。', navigationError));
  }
  if (httpStatus !== null && httpStatus >= 400) {
    findings.push(finding('page_http_error', 'blocking', `详情页返回 HTTP ${httpStatus}。`, String(httpStatus)));
  }
  if (diagnostics.signInRedirect) {
    findings.push(finding('auth_redirect', 'blocking', '详情页被重定向到登录页，无法审核真实阅读面。', diagnostics.url));
  }
  if (diagnostics.evaluateError) {
    findings.push(finding('dom_inspection_failed', 'blocking', '浏览器审核无法读取详情页 DOM。', diagnostics.evaluateError));
  }
  if (diagnostics.horizontalOverflow) {
    findings.push(finding('horizontal_overflow', 'blocking', '页面在当前视口出现非预期横向溢出。', viewport.name));
  }
  if (diagnostics.mainTextChars < 160 || !diagnostics.introPresent) {
    findings.push(finding('content_not_visible', 'blocking', '首屏没有形成可阅读的详情内容。', `mainTextChars=${diagnostics.mainTextChars}`));
  }
  if (/正文渲染中|正在加载雷达详情|文章地图加载中/iu.test(diagnostics.skeletonText)) {
    findings.push(finding('loading_state_stuck', 'blocking', '等待窗口结束后页面仍停留在加载占位状态。', diagnostics.skeletonText));
  }
  const brokenImages = (diagnostics.images ?? []).filter((image) => !image.complete || image.naturalWidth === 0);
  if (brokenImages.length > 0) {
    findings.push(finding(
      'broken_image',
      'blocking',
      '正文中存在浏览器实际加载失败的图片。',
      brokenImages.slice(0, 5).map((image) => image.src).join('\n'),
    ));
  }
  const overflowingTables = (diagnostics.tables ?? []).filter(
    (table) => table.scrollWidth > table.viewportWidth + 8 && !table.wrapped,
  );
  if (overflowingTables.length > 0) {
    findings.push(finding(
      'table_overflow',
      'blocking',
      '表格超出视口且没有可用的横向滚动容器。',
      JSON.stringify(overflowingTables.slice(0, 3)),
    ));
  }
  if ((diagnostics.visibleMathml ?? 0) > 0) {
    findings.push(finding(
      'visible_mathml_duplicate',
      'warning',
      'KaTeX MathML 辅助树在页面中可见，可能造成公式文本重复。',
      `visibleMathml=${diagnostics.visibleMathml}`,
    ));
  }
  if (diagnostics.mermaidError) {
    findings.push(finding('mermaid_render_error', 'blocking', '页面显示 Mermaid 渲染错误。', 'Syntax error in text'));
  }
  if (diagnostics.mobileContentBelowFold) {
    findings.push(finding(
      'mobile_content_below_fold',
      'warning',
      '移动端正文阅读起点被推到首屏很远之后。',
      `firstBlockTop=${diagnostics.firstBlockTop}`,
    ));
  }
  if (consoleErrors.length > 0) {
    findings.push(finding('console_error', 'blocking', '页面产生 console error。', consoleErrors.slice(0, 5).join('\n')));
  }
  if (pageErrors.length > 0) {
    findings.push(finding('page_error', 'blocking', '页面产生未捕获的运行时错误。', pageErrors.slice(0, 5).join('\n')));
  }
  if (failedRequests.length > 0 || badResponses.length > 0) {
    findings.push(finding(
      'network_failure',
      'blocking',
      '详情页关键资源或接口请求失败。',
      JSON.stringify({
        failedRequests: failedRequests.slice(0, 5),
        badResponses: badResponses.slice(0, 5),
      }),
    ));
  }

  await context.close();
  return {
    viewport,
    httpStatus,
    navigationError,
    diagnostics,
    findings,
    consoleErrors,
    pageErrors,
    failedRequests,
    badResponses,
  };
}

let browser;
try {
  const launchOptions = { headless: true };
  if (process.env.RADAR_RENDER_REVIEW_EXECUTABLE_PATH) {
    launchOptions.executablePath = process.env.RADAR_RENDER_REVIEW_EXECUTABLE_PATH;
  }
  browser = await chromium.launch(launchOptions);
  const viewportsResults = [];
  for (const viewport of viewports) {
    viewportsResults.push(await inspectViewport(browser, viewport));
  }
  const findings = viewportsResults.flatMap((item) => item.findings);
  const status = findings.some((item) => item.severity === 'blocking' || item.severity === 'warning')
    ? 'needs_manual_review'
    : 'approved';
  console.log(JSON.stringify({
    status,
    round: Number.isFinite(round) ? round : 1,
    summary: status === 'approved'
      ? '桌面与移动端真实浏览器审核通过。'
      : `真实浏览器审核发现 ${findings.length} 个展示问题，需要修复后复审。`,
    findings,
    viewports: viewportsResults,
  }));
} catch (error) {
  console.log(JSON.stringify({
    status: 'unavailable',
    round: Number.isFinite(round) ? round : 1,
    summary: '真实浏览器审核未完成。',
    error: String(error).slice(0, 1000),
  }));
} finally {
  await browser?.close();
}
