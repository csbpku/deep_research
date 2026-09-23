import { readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { chromium } from '../../../apps/web/node_modules/@playwright/test/index.mjs';
import { translateImage } from '../reader-core.js';

const manifestPath = process.env.READER_IMAGE_CORPUS
  || '/private/tmp/deep-research-reader-image-corpus-1789898221386.json';
const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
const baseUrl = process.env.READER_LIVE_BASE_URL;
const model = process.env.READER_LIVE_VISION_MODEL || process.env.READER_LIVE_MODEL;
const apiKey = process.env.READER_LIVE_API_KEY;
if (!baseUrl || !model || !apiKey) {
  throw new Error('图片 benchmark 需要 READER_LIVE_BASE_URL、READER_LIVE_VISION_MODEL/READER_LIVE_MODEL 和 READER_LIVE_API_KEY');
}

const provider = {
  baseUrl,
  model,
  visionModel: model,
  apiKey,
  language: process.env.READER_LIVE_LANGUAGE || 'zh-CN',
  visionReady: true,
};
const document = { title: '真实技术图片基准' };
const items = Array.isArray(manifest.items) ? manifest.items.slice(0, 30) : [];
// The mixed corpus intentionally includes decorative photos and illustrations.
// A corpus must carry a human label before the text-bearing success rate is
// reported.  Without labels, leave the value unknown instead of inferring
// that a model failure means "no text".  For one-off reviews callers may pass
// a comma-separated list of IDs known to contain no readable text.
const noTextIds = new Set((process.env.READER_IMAGE_NO_TEXT_IDS
  || '')
  .split(',').map((value) => value.trim()).filter(Boolean));
const prepared = [];
let rasterBrowser = null;
let rasterPage = null;

async function ensureRasterPage() {
  if (rasterPage) return rasterPage;
  const executablePath = process.env.CHROME_FOR_TESTING
    || [
      '/Users/shaobo.chen/Library/Caches/ms-playwright/chromium-1234/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing',
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    ].find(existsSync);
  if (!executablePath) throw new Error('图片尺寸读取需要 Chrome，请设置 CHROME_FOR_TESTING');
  rasterBrowser = await chromium.launch({ executablePath, headless: true });
  rasterPage = await rasterBrowser.newPage();
  return rasterPage;
}

async function rasterizeSvg(dataUrl, width, height) {
  const page = await ensureRasterPage();
  return page.evaluate(async ({ source, sourceWidth, sourceHeight }) => {
    const image = new Image();
    image.src = source;
    await image.decode();
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.min(2400, Math.round(Number(sourceWidth) || image.naturalWidth || 1)));
    canvas.height = Math.max(1, Math.min(2400, Math.round(Number(sourceHeight) || image.naturalHeight || 1)));
    const context = canvas.getContext('2d');
    if (!context) throw new Error('无法创建 SVG 栅格化画布');
    context.drawImage(image, 0, 0, canvas.width, canvas.height);
    return canvas.toDataURL('image/png');
  }, { source: dataUrl, sourceWidth: width, sourceHeight: height });
}

async function measureImage(dataUrl) {
  const page = await ensureRasterPage();
  return page.evaluate(async (source) => {
    const image = new Image();
    image.src = source;
    await image.decode();
    return { width: image.naturalWidth || image.width || 0, height: image.naturalHeight || image.height || 0 };
  }, dataUrl);
}

for (const [index, item] of items.entries()) {
  try {
    const response = await fetch(item.src, { signal: AbortSignal.timeout(30_000) });
    if (!response.ok) throw new Error(`图片读取失败（${response.status}）`);
    const contentType = response.headers.get('content-type') || 'image/png';
    if (!/^image\//iu.test(contentType)) throw new Error(`非图片内容：${contentType}`);
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.byteLength > 6 * 1024 * 1024) throw new Error(`图片超过 6MB：${bytes.byteLength}`);
    let binary = '';
    for (let offset = 0; offset < bytes.length; offset += 0x8000) binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
    let dataUrl = `data:${contentType};base64,${btoa(binary)}`;
    if (/^image\/svg\+xml$/iu.test(contentType)) dataUrl = await rasterizeSvg(dataUrl, item.width, item.height);
    const measured = await measureImage(dataUrl);
    prepared.push({
      id: `real-image-${index + 1}`,
      src: item.src,
      dataUrl,
      alt: item.alt || '',
      width: measured.width || Number(item.width) || 0,
      height: measured.height || Number(item.height) || 0,
      status: 'ready',
      pageUrl: item.pageUrl,
      expectedText: typeof item.expectedText === 'boolean' ? item.expectedText : undefined,
      difficulty: item.difficulty || null,
      reviewed: item.reviewed === true,
    });
  } catch (error) {
    prepared.push({
      id: `real-image-${index + 1}`,
      src: item.src,
      alt: item.alt || '',
      width: Number(item.width) || 0,
      height: Number(item.height) || 0,
      pageUrl: item.pageUrl,
      expectedText: typeof item.expectedText === 'boolean' ? item.expectedText : undefined,
      difficulty: item.difficulty || null,
      reviewed: item.reviewed === true,
      preparationError: error instanceof Error ? error.message : '图片读取失败',
    });
  }
  console.log(JSON.stringify({ id: `real-image-${index + 1}`, prepared: Boolean(prepared.at(-1).dataUrl) }));
}

const results = new Array(prepared.length);
let cursor = 0;
const concurrency = Math.max(1, Math.min(2, Number(process.env.READER_IMAGE_CONCURRENCY || 2)));
async function worker() {
  while (cursor < prepared.length) {
    const index = cursor;
    cursor += 1;
    const image = prepared[index];
    const expectedText = typeof image.expectedText === 'boolean'
      ? image.expectedText
      : (noTextIds.size ? !noTextIds.has(image.id) : null);
    if (image.preparationError) {
      results[index] = { id: image.id, src: image.src, pageUrl: image.pageUrl, expectedText, difficulty: image.difficulty || null, reviewed: image.reviewed === true, status: 'read_failed', error: image.preparationError };
      continue;
    }
    const startedAt = Date.now();
    try {
      const result = await translateImage(provider, document, image, { signal: AbortSignal.timeout(120_000) });
      results[index] = {
        id: image.id,
        src: image.src,
        pageUrl: image.pageUrl,
        expectedText,
        difficulty: image.difficulty || null,
        reviewed: image.reviewed === true,
        width: image.width,
        height: image.height,
        status: result.regions?.length ? 'overlay' : result.fallbackText ? 'fallback' : result.noText ? 'no_text' : 'unusable',
        elapsedMs: Date.now() - startedAt,
        confidence: Number(result.confidence) || 0,
        regionCount: Array.isArray(result.regions) ? result.regions.length : 0,
        fallback: Boolean(result.fallbackText),
        note: result.note || '',
        sourceWarning: result.sourceWarning || '',
      };
    } catch (error) {
      results[index] = { id: image.id, src: image.src, pageUrl: image.pageUrl, expectedText, difficulty: image.difficulty || null, reviewed: image.reviewed === true, status: 'model_failed', elapsedMs: Date.now() - startedAt, error: error instanceof Error ? error.message : '模型请求失败' };
    }
    console.log(JSON.stringify({ id: image.id, status: results[index].status, confidence: results[index].confidence ?? null }));
  }
}
await Promise.all(Array.from({ length: concurrency }, () => worker()));
await rasterBrowser?.close();

const summary = {
  total: results.length,
  prepared: results.filter((item) => item.status !== 'read_failed').length,
  overlay: results.filter((item) => item.status === 'overlay').length,
  fallback: results.filter((item) => item.status === 'fallback').length,
  noText: results.filter((item) => item.status === 'no_text').length,
  usable: results.filter((item) => item.status === 'overlay' || item.status === 'fallback').length,
  failed: results.filter((item) => item.status === 'read_failed' || item.status === 'model_failed' || item.status === 'unusable').length,
  highConfidenceOverlay: results.filter((item) => item.status === 'overlay' && item.confidence >= 0.75).length,
  textBearing: results.filter((item) => item.expectedText === true).length,
  textBearingUsable: results.filter((item) => item.expectedText === true && (item.status === 'overlay' || item.status === 'fallback')).length,
  textBearingOverlay: results.filter((item) => item.expectedText === true && item.status === 'overlay').length,
  byDifficulty: Object.fromEntries([...new Set(results.map((item) => item.difficulty || 'unclassified'))].map((difficulty) => {
    const group = results.filter((item) => (item.difficulty || 'unclassified') === difficulty);
    return [difficulty, {
      total: group.length,
      reviewed: group.filter((item) => item.reviewed).length,
      overlay: group.filter((item) => item.status === 'overlay').length,
      fallback: group.filter((item) => item.status === 'fallback').length,
      noText: group.filter((item) => item.status === 'no_text').length,
      failed: group.filter((item) => item.status === 'read_failed' || item.status === 'model_failed' || item.status === 'unusable').length,
      textBearing: group.filter((item) => item.expectedText === true).length,
      textBearingUsable: group.filter((item) => item.expectedText === true && (item.status === 'overlay' || item.status === 'fallback')).length,
    }];
  })),
  latencyMs: (() => {
    const values = results.map((item) => Number(item.elapsedMs)).filter(Number.isFinite).sort((a, b) => a - b);
    if (!values.length) return null;
    const percentile = (fraction) => values[Math.min(values.length - 1, Math.floor(values.length * fraction))];
    return { p50: percentile(0.5), p95: percentile(0.95), max: values.at(-1) };
  })(),
};
const outputPath = process.env.READER_IMAGE_BENCHMARK_OUTPUT
  || `/private/tmp/deep-research-reader-image-benchmark-${Date.now()}.json`;
await writeFile(outputPath, JSON.stringify({ generatedAt: new Date().toISOString(), model, summary, results }, null, 2));
console.log(JSON.stringify({ outputPath, summary }, null, 2));
