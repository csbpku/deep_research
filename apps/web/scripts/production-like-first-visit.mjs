import { chromium } from '@playwright/test';
import fs from 'node:fs';

const baseURL = process.env.E2E_BASE_URL ?? 'http://localhost:3000';
const routes = (process.env.PERF_ROUTES ?? '/radar,/researches,/ai-research')
  .split(',')
  .map((route) => route.trim())
  .filter(Boolean);
const detailRoute = process.env.RADAR_DETAIL_ROUTE?.trim();
if (detailRoute) routes.push(detailRoute);

const storageStatePath = process.env.E2E_STORAGE_STATE;
const browser = await chromium.launch({
  headless: true,
  executablePath: process.env.CHROME_EXECUTABLE ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
});

const results = [];
for (const route of routes) {
  const context = await browser.newContext({
    storageState: storageStatePath && fs.existsSync(storageStatePath) ? storageStatePath : undefined,
  });
  const page = await context.newPage();
  const consoleMessages = [];
  const jsResponses = [];

  page.on('console', (message) => {
    if (message.type() === 'error' || message.type() === 'warning') {
      consoleMessages.push({ type: message.type(), text: message.text() });
    }
  });
  page.on('response', async (response) => {
    const request = response.request();
    if (request.resourceType() !== 'script') return;
    const headers = response.headers();
    const contentLength = Number(headers['content-length'] ?? 0);
    jsResponses.push({
      url: response.url(),
      bytes: Number.isFinite(contentLength) ? contentLength : 0,
    });
  });

  const startedAt = performance.now();
  const response = await page.goto(new URL(route, baseURL).toString(), {
    waitUntil: 'domcontentloaded',
    timeout: 45_000,
  });
  const domContentLoaded = performance.now() - startedAt;
  // Detail pages render separate responsive intro blocks. The first DOM h1
  // can be the hidden mobile/desktop variant, so measure the visible title.
  const title = page.locator('main h1:visible').first();
  const titleStartedAt = performance.now();
  await title.waitFor({ state: 'visible', timeout: 45_000 }).catch(() => undefined);
  const firstTitleVisible = performance.now() - titleStartedAt;
  const metrics = await page.evaluate(() => {
    const entries = performance.getEntriesByType('resource');
    const firstPaint = performance.getEntriesByName('first-contentful-paint')[0];
    const js = entries.filter((entry) => entry.name.includes('/_next/static/') && entry.name.endsWith('.js'));
    return {
      firstContentfulPaint: firstPaint?.startTime ?? null,
      jsRequestCount: js.length,
      jsBytes: js.reduce((sum, entry) => sum + (entry.transferSize || 0), 0),
      hasHorizontalOverflow: document.documentElement.scrollWidth > window.innerWidth + 1,
      markdownOrKatexResources: js
        .map((entry) => entry.name)
        .filter((url) => /markdown|katex|remark|rehype/i.test(url)),
    };
  });

  results.push({
    route,
    httpStatus: response?.status() ?? null,
    domContentLoadedMs: Math.round(domContentLoaded),
    firstTitleVisibleMs: Math.round(firstTitleVisible),
    ...metrics,
    consoleMessages,
    scriptResponses: jsResponses,
  });
  await context.close();
}

await browser.close();
console.log(JSON.stringify({ baseURL, routes, results }, null, 2));
