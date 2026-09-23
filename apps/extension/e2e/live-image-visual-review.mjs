import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { chromium } from '../../../apps/web/node_modules/@playwright/test/index.mjs';
import { translateImage } from '../reader-core.js';

// This is an intentionally opt-in visual QA harness. It keeps the image bytes,
// model regions and rendered overlays under /private/tmp so public reports do
// not accidentally contain source images or model credentials.
const corpusPath = process.env.READER_IMAGE_CORPUS
  || '/private/tmp/deep-research-reader-image-corpus-1789898221386.json';
const outputDir = process.env.READER_IMAGE_REVIEW_DIR
  || `/private/tmp/deep-research-reader-image-visual-review-${Date.now()}`;
const baseUrl = process.env.READER_LIVE_BASE_URL;
const model = process.env.READER_LIVE_VISION_MODEL || process.env.READER_LIVE_MODEL;
const apiKey = process.env.READER_LIVE_API_KEY;
if (!baseUrl || !model || !apiKey) {
  throw new Error('视觉复核需要 READER_LIVE_BASE_URL、READER_LIVE_VISION_MODEL/READER_LIVE_MODEL 和 READER_LIVE_API_KEY');
}

const manifest = JSON.parse(await readFile(corpusPath, 'utf8'));
const items = Array.isArray(manifest.items) ? manifest.items.slice(0, 30) : [];
if (!items.length) throw new Error(`图片 corpus 为空：${corpusPath}`);
await mkdir(outputDir, { recursive: true });

const provider = {
  baseUrl,
  model,
  visionModel: model,
  apiKey,
  language: process.env.READER_LIVE_LANGUAGE || 'zh-CN',
  visionReady: true,
};

const executablePath = process.env.CHROME_FOR_TESTING
  || [
    '/Users/shaobo.chen/Library/Caches/ms-playwright/chromium-1234/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  ].find(existsSync);
if (!executablePath) throw new Error('找不到 Chrome，请设置 CHROME_FOR_TESTING');

const browser = await chromium.launch({ executablePath, headless: true });
const page = await browser.newPage();

async function imageDataUrl(item) {
  const response = await fetch(item.src, { signal: AbortSignal.timeout(30_000) });
  if (!response.ok) throw new Error(`图片读取失败（${response.status}）`);
  const contentType = response.headers.get('content-type') || 'image/png';
  if (!/^image\//iu.test(contentType)) throw new Error(`非图片内容：${contentType}`);
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.byteLength > 6 * 1024 * 1024) throw new Error(`图片超过 6MB：${bytes.byteLength}`);
  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  }
  return `data:${contentType};base64,${btoa(binary)}`;
}

async function renderOverlay(source, regions, fallbackRegions, fallbackText, outputPath) {
  const rendered = await page.evaluate(async ({ source: imageSource, regions: imageRegions, fallbackRegions: imageFallbacks, fallbackText: imageFallbackText }) => {
    const image = new Image();
    image.src = imageSource;
    await image.decode();
    const canvas = document.createElement('canvas');
    const imageWidth = image.naturalWidth || image.width;
    const imageHeight = image.naturalHeight || image.height;
    const sideWidth = Math.min(280, Math.max(150, imageWidth * 0.34));
    const belowCount = (imageFallbacks || []).filter((region) => {
      const x = Number(region.x);
      const width = Number(region.width);
      return imageWidth - (x + width) < sideWidth + 10 && x < sideWidth + 10;
    }).length;
    const unanchoredHeight = imageFallbackText && !(imageFallbacks || []).length ? 88 : 0;
    // Keep a real external gutter on both sides of the source image. Side
    // translations must never be drawn over source pixels.
    const sideMargin = sideWidth + 12;
    canvas.width = imageWidth + sideMargin * 2;
    canvas.height = imageHeight + (belowCount ? belowCount * 46 + 8 : 0) + unanchoredHeight;
    const context = canvas.getContext('2d');
    if (!context) throw new Error('无法创建图片复核画布');
    context.drawImage(image, sideMargin, 0);
    context.textBaseline = 'top';
    for (const region of imageRegions || []) {
      const x = Number(region.x);
      const y = Number(region.y);
      const width = Number(region.width);
      const height = Number(region.height);
      if (![x, y, width, height].every(Number.isFinite) || width <= 0 || height <= 0) continue;
      // Match the page overlay: a translucent fill would leave the source
      // glyphs visible and make visual QA under-report residual text.
      context.fillStyle = '#fff';
      const drawX = x + sideMargin;
      context.fillRect(drawX, y, width, height);
      context.strokeStyle = '#315fe8';
      context.lineWidth = Math.max(2, Math.round(Math.min(width, height) / 35));
      context.strokeRect(drawX, y, width, height);
      const text = String(region.translation || '').trim();
      if (!text) continue;
      const verticalLabel = height >= 48 && height >= width * 2;
      const fontSize = verticalLabel
        ? Math.max(8, Math.min(18, Math.round(width * 0.8)))
        : Math.max(8, Math.min(24, Math.round(height * 0.5)));
      const lineHeight = Math.round(fontSize * 1.12);
      context.font = `600 ${fontSize}px -apple-system, BlinkMacSystemFont, sans-serif`;
      context.fillStyle = '#172554';
      if (verticalLabel) {
        context.save();
        context.translate(drawX + width / 2, y + height - 4);
        context.rotate(-Math.PI / 2);
        context.textAlign = 'left';
        context.fillText(String(region.translation || '').trim(), 0, 0, Math.max(12, height - 6));
        context.restore();
        continue;
      }
      const maxWidth = Math.max(12, width - 6);
      const maxLines = Math.max(1, Math.floor(Math.max(1, height - 4) / lineHeight));
      const words = [...text];
      let line = '';
      let lineY = y + 5;
      let lineCount = 0;
      context.save();
      context.beginPath();
      context.rect(drawX, y, width, height);
      context.clip();
      for (const char of words) {
        const candidate = line + char;
        if (context.measureText(candidate).width > maxWidth && line) {
          if (lineCount >= maxLines) break;
          context.fillText(line, drawX + 3, lineY, maxWidth);
          lineCount += 1;
          line = char;
          lineY += lineHeight;
        } else {
          line = candidate;
        }
      }
      if (line && lineCount < maxLines) context.fillText(line, drawX + 3, lineY, maxWidth);
      context.restore();
    }
    context.font = '600 12px -apple-system, BlinkMacSystemFont, sans-serif';
    let belowIndex = 0;
    for (const region of imageFallbacks || []) {
      const x = Number(region.x);
      const y = Number(region.y);
      const width = Number(region.width);
      const height = Number(region.height);
      if (![x, y, width, height].every(Number.isFinite) || width <= 0 || height <= 0) continue;
      let left;
      let top = y;
      if (sideMargin >= sideWidth + 10) {
        left = sideMargin + imageWidth + 8;
      } else {
        left = sideMargin + Math.max(0, Math.min(imageWidth - sideWidth, x));
        top = imageHeight + 8 + belowIndex * 46;
        belowIndex += 1;
      }
      const labelWidth = Math.min(sideWidth, imageWidth);
      const sourceText = String(region.text || '').trim().replace(/\s+/gu, ' ');
      const text = sourceText
        ? `原文：${sourceText.slice(0, 120)}\n译文：${String(region.translation || '').trim()}`
        : String(region.translation || '').trim();
      const labelHeight = Math.min(180, Math.max(42, 28 + Math.ceil(text.length / 24) * 16));
      context.fillStyle = '#fff9e2';
      context.strokeStyle = '#d19a38';
      context.lineWidth = 2;
      context.fillRect(left, top, labelWidth, labelHeight);
      context.strokeRect(left, top, labelWidth, labelHeight);
      context.fillStyle = '#60491d';
      const maxWidth = Math.max(12, labelWidth - 14);
      let line = '';
      let lineY = top + 6;
      for (const character of text) {
        const candidate = line + character;
        if (context.measureText(candidate).width > maxWidth && line) {
          context.fillText(line, left + 7, lineY, maxWidth);
          line = character;
          lineY += 15;
          if (lineY > top + labelHeight - 4) break;
        } else line = candidate;
      }
      if (line && lineY <= top + labelHeight - 4) context.fillText(line, left + 7, lineY, maxWidth);
    }
    if (imageFallbackText && !(imageFallbacks || []).length) {
      const top = imageHeight + 8;
      const labelHeight = Math.min(80, Math.max(36, 20 + Math.ceil(String(imageFallbackText).length / 50) * 15));
      context.fillStyle = '#fff6df';
      context.strokeStyle = '#d19a38';
      context.lineWidth = 2;
      context.fillRect(sideMargin, top, imageWidth, labelHeight);
      context.strokeRect(sideMargin, top, imageWidth, labelHeight);
      context.fillStyle = '#60491d';
      context.fillText(`整图旁侧说明：${String(imageFallbackText).slice(0, 220)}`, sideMargin + 7, top + 7, Math.max(12, imageWidth - 14));
    }
    return canvas.toDataURL('image/png');
  }, { source, regions, fallbackRegions, fallbackText });
  const base64 = rendered.slice('data:image/png;base64,'.length);
  await writeFile(outputPath, Buffer.from(base64, 'base64'));
}

async function rasterizeSvg(source, width, height) {
  if (!/^data:image\/svg(?:\+xml)?(?:;|,)/iu.test(source)) return source;
  return page.evaluate(async ({ source: imageSource, sourceWidth, sourceHeight }) => {
    const image = new Image();
    image.src = imageSource;
    await image.decode();
    const canvas = document.createElement('canvas');
    const naturalWidth = image.naturalWidth || Number(sourceWidth) || 1;
    const naturalHeight = image.naturalHeight || Number(sourceHeight) || 1;
    const scale = Math.min(1, 2400 / Math.max(naturalWidth, naturalHeight));
    canvas.width = Math.max(1, Math.round(naturalWidth * scale));
    canvas.height = Math.max(1, Math.round(naturalHeight * scale));
    const context = canvas.getContext('2d');
    if (!context) throw new Error('无法创建 SVG 复核画布');
    context.drawImage(image, 0, 0, canvas.width, canvas.height);
    return canvas.toDataURL('image/png');
  }, { source: source, sourceWidth: width, sourceHeight: height });
}

const results = [];
for (const [index, item] of items.entries()) {
  const id = `real-image-${index + 1}`;
  const result = { id, src: item.src, pageUrl: item.pageUrl, difficulty: item.difficulty || null };
  try {
    const source = await imageDataUrl(item);
    const measured = await page.evaluate(async (dataUrl) => {
      const image = new Image();
      image.src = dataUrl;
      await image.decode();
      return { width: image.naturalWidth || image.width || 0, height: image.naturalHeight || image.height || 0 };
    }, source);
    const modelSource = await rasterizeSvg(source, measured.width || item.width, measured.height || item.height);
    const modelMeasured = await page.evaluate(async (dataUrl) => {
      const image = new Image();
      image.src = dataUrl;
      await image.decode();
      return { width: image.naturalWidth || image.width || 0, height: image.naturalHeight || image.height || 0 };
    }, modelSource);
    const translated = await translateImage(provider, { title: '真实技术图片视觉复核' }, {
      id,
      src: item.src,
      dataUrl: modelSource,
      alt: item.alt || '',
      width: measured.width || Number(item.width) || 0,
      height: measured.height || Number(item.height) || 0,
      modelWidth: modelMeasured.width || measured.width || Number(item.width) || 0,
      modelHeight: modelMeasured.height || measured.height || Number(item.height) || 0,
      status: 'ready',
    }, { signal: AbortSignal.timeout(120_000) });
    const renderedPath = `${outputDir}/${String(index + 1).padStart(2, '0')}.png`;
    // Render against the original source dimensions. translateImage maps
    // model-raster coordinates back to this source space before returning
    // regions, so the QA image exercises the same contract as the page.
    await renderOverlay(source, translated.regions || [], translated.fallbackRegions || [], translated.fallbackText || '', renderedPath);
    const status = translated.regions?.length
      ? 'overlay'
      : translated.fallbackText
        ? 'fallback'
        : translated.noText
          ? 'no_text'
          : translated.keptOriginal
            ? 'kept_original'
            : 'retryable';
    results.push({
      ...result,
      renderedPath,
      status,
      confidence: Number(translated.confidence) || 0,
      keptOriginal: Boolean(translated.keptOriginal),
      regions: (translated.regions || []).map((region) => ({
        text: String(region.text || ''),
        translation: String(region.translation || ''),
        x: Number(region.x), y: Number(region.y), width: Number(region.width), height: Number(region.height),
      })),
      fallbackRegions: (translated.fallbackRegions || []).map((region) => ({
        text: String(region.text || ''),
        translation: String(region.translation || ''),
        x: Number(region.x), y: Number(region.y), width: Number(region.width), height: Number(region.height),
      })),
      fallbackText: translated.fallbackText || '',
      note: translated.note || '',
    });
    console.log(JSON.stringify({ id, status: results.at(-1).status, confidence: results.at(-1).confidence, renderedPath }));
  } catch (error) {
    const renderedPath = `${outputDir}/${String(index + 1).padStart(2, '0')}.png`;
    results.push({ ...result, renderedPath, status: 'failed', error: error instanceof Error ? error.message : '视觉复核失败' });
    console.log(JSON.stringify({ id, status: 'failed', renderedPath }));
  }
}

await browser.close();
const outputPath = `${outputDir}/results.json`;
await writeFile(outputPath, JSON.stringify({ generatedAt: new Date().toISOString(), model, results }, null, 2));
console.log(JSON.stringify({ outputDir, outputPath, total: results.length, overlay: results.filter((item) => item.status === 'overlay').length, fallback: results.filter((item) => item.status === 'fallback').length, noText: results.filter((item) => item.status === 'no_text').length, keptOriginal: results.filter((item) => item.status === 'kept_original').length, retryable: results.filter((item) => item.status === 'retryable').length, failed: results.filter((item) => item.status === 'failed').length }, null, 2));
