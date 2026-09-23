import { existsSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { chromium } from '../../../apps/web/node_modules/@playwright/test/index.mjs';

// Collect only public, already-rendered image URLs from the same page classes
// used by the live compatibility matrix.  The corpus contains metadata and
// URLs, never page text or cookies.  It is an input manifest for the optional
// real-provider image benchmark, not a permanent document archive.
const pages = [
  'https://developer.chrome.com/docs/extensions/develop/concepts/content-scripts',
  'https://developer.mozilla.org/en-US/docs/Web/API/MutationObserver',
  'https://react.dev/learn',
  'https://nodejs.org/api/worker_threads.html',
  'https://docs.python.org/3/library/asyncio.html',
  'https://www.postgresql.org/docs/current/index.html',
  'https://stripe.dev/blog/payment-api-design',
  'https://aws.amazon.com/blogs/architecture/exponential-backoff-and-jitter/',
  'https://martinfowler.com/articles/patterns-of-distributed-systems/',
  'https://blog.cloudflare.com/',
  'https://blog.rust-lang.org/',
  'https://engineering.atspotify.com/',
  'https://github.com/microsoft/TypeScript',
  'https://github.com/react/react',
  'https://github.com/denoland/deno',
  'https://github.com/torvalds/linux',
  'https://github.com/Fission-AI/OpenSpec',
  'https://github.com/wxt-dev/wxt',
  'https://zread.ai/Fission-AI/OpenSpec',
  'https://zread.ai/microsoft/TypeScript',
  'https://zread.ai/facebook/react',
  'https://zread.ai/denoland/deno',
  'https://zread.ai/torvalds/linux',
  'https://zread.ai/wxt-dev/wxt',
];

const executablePath = process.env.CHROME_FOR_TESTING
  || [
    '/Users/shaobo.chen/Library/Caches/ms-playwright/chromium-1234/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  ].find(existsSync);
if (!executablePath) throw new Error('找不到 Chrome，请设置 CHROME_FOR_TESTING');

const browser = await chromium.launch({ executablePath, headless: true });
const page = await browser.newPage({ viewport: { width: 1360, height: 900 } });
const seen = new Set();
const candidates = [];
const includeSvg = process.env.READER_IMAGE_INCLUDE_SVG === '1';

try {
  for (const url of pages) {
    try {
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 25_000 });
      await page.waitForTimeout(1_200);
      const images = await page.evaluate(async ({ includeSvg: allowSvg }) => {
        const nodes = Array.from(document.querySelectorAll('article img, main img, [role="main"] img, #readme img'));
        // Trigger lazy loading before measuring; pages remain bounded and no
        // automatic pagination or infinite scroll is performed.
        nodes.slice(0, 60).forEach((node) => node.scrollIntoView({ block: 'center' }));
        await new Promise((resolve) => setTimeout(resolve, 500));
        return nodes.map((node) => ({
          src: node.currentSrc || node.src || '',
          alt: node.alt || node.getAttribute('aria-label') || '',
          width: node.naturalWidth || node.width || 0,
          height: node.naturalHeight || node.height || 0,
        })).filter((item) => /^https?:\/\//iu.test(item.src)
          && item.width >= 160 && item.height >= 100
          // SVG is a first-class extension input, but the browser benchmark
          // keeps a raster-only corpus so provider quality is not conflated
          // with the separate SVG→PNG compatibility path.
          && (allowSvg || !/\.svg(?:[?#]|$)/iu.test(item.src)));
      }, { includeSvg });
      for (const image of images) {
        if (seen.has(image.src)) continue;
        seen.add(image.src);
        candidates.push({ pageUrl: url, ...image });
        if (candidates.length >= 30) break;
      }
      console.log(JSON.stringify({ page: url, found: images.length, corpus: candidates.length }));
      if (candidates.length >= 30) break;
    } catch (error) {
      console.log(JSON.stringify({ page: url, error: error instanceof Error ? error.message.split('\n')[0] : '导航失败' }));
    }
  }
} finally {
  await browser.close();
}

const outputPath = process.env.READER_IMAGE_CORPUS_OUTPUT
  || `/private/tmp/deep-research-reader-image-corpus-${Date.now()}.json`;
await writeFile(outputPath, JSON.stringify({ generatedAt: new Date().toISOString(), count: candidates.length, items: candidates }, null, 2));
console.log(JSON.stringify({ outputPath, count: candidates.length, pages: new Set(candidates.map((item) => item.pageUrl)).size }, null, 2));
if (candidates.length < 30) process.exitCode = 2;
