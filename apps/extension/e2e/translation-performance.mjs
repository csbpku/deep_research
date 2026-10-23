// Controlled model latency in a real browser. This isolates scheduling/cache
// effects; these timings are not a claim about live provider throughput.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { execFileSync } from 'node:child_process';
import { readFile, mkdtemp, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { chromium } from '../../web/node_modules/@playwright/test/index.mjs';
import { join } from 'node:path';
import { tempDir, tempPath } from './temp-paths.mjs';

const compareRef = process.env.READER_COMPARE_REF || '';
const articleUrl = process.env.READER_PERF_ARTICLE_URL || '';
const directory = await mkdtemp(join(tempDir(), 'reader-translation-performance-'));
const metrics = new Map();
const server = createServer(async (req, res) => {
  try {
    const path = new URL(req.url, 'http://localhost').pathname;
    if (path.endsWith('/chat/completions')) {
      let raw = ''; for await (const chunk of req) raw += chunk;
      const input = JSON.parse(raw);
      const content = input.messages.at(-1).content;
      const key = path.split('/')[2];
      const metric = metrics.get(key);
      metric.requests++;
      metric.active++;
      metric.peak = Math.max(metric.peak, metric.active);
      const batch = content.includes('<<<TRANSLATION_BATCH>>>')
        ? JSON.parse(content.split('<<<TRANSLATION_BATCH>>>\n')[1]).blocks : null;
      const single = batch ? '' : content.match(/<<<SOURCE_TEXT>>>\n([\s\S]*?)\n<<<END_SOURCE_TEXT>>>/u)?.[1];
      assert.ok(batch || single);
      const chars = batch ? batch.reduce((sum, item) => sum + item.text.length, 0) : single.length;
      await new Promise(resolve => setTimeout(resolve, 80 + chars * 0.15));
      let answer = batch
        ? JSON.stringify({ translations: batch.map(item => ({ id: item.id, text: `译文：${item.text}` })) })
        : `译文：${single}`;
      if (batch && metric.scenario === 'malformed') answer = 'invalid JSON';
      if (batch && metric.scenario === 'partial') answer = JSON.stringify({ translations: batch.slice(0, -1).map(item => ({ id: item.id, text: `译文：${item.text}` })) });
      metric.active--;
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ choices: [{ message: { content: answer } }] }));
      return;
    }
    if (path.endsWith('.js')) {
      const name = path.split('/').at(-1);
      if (!/^[a-z-]+\.js$/u.test(name)) { res.writeHead(404); res.end(); return; }
      const source = path.startsWith('/baseline/') && ['reader-core.js', 'reader-store.js'].includes(name)
        ? execFileSync('git', ['show', `${compareRef}:apps/extension/${name}`], { encoding: 'utf8', maxBuffer: 5_000_000 })
        : await readFile(new URL(`../${name}`, import.meta.url), 'utf8');
      res.setHeader('content-type', 'application/javascript'); res.end(source); return;
    }
    res.setHeader('content-type', 'text/html');
    res.end('<!doctype html><meta charset="utf-8"><title>Reader translation timing</title><main></main>');
  } catch (error) { res.writeHead(500); res.end(String(error)); }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
const executablePath = process.env.CHROME_FOR_TESTING || [
  '/Users/shaobo.chen/Library/Caches/ms-playwright/chromium-1234/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
].find(existsSync);
const browser = await chromium.launch({ executablePath, headless: true });
try {
  let document = {
    title: 'Translation scheduling benchmark',
    blocks: Array.from({ length: 80 }, (_, i) => ({ id: `source-${i}`, kind: 'text', text: `Section ${i}. ${'A queue preserves context and applies each completed paragraph to the page. '.repeat(4)}` })),
  };
  if (articleUrl) {
    const article = await browser.newPage();
    await article.goto(articleUrl, { waitUntil: 'domcontentloaded', timeout: 60_000 });
    document = await article.evaluate(() => {
      const root = document.querySelector('article') || document.querySelector('main') || document.body;
      const nodes = [...root.querySelectorAll('h1,h2,h3,h4,p,li,td,th')].filter(node => !node.closest('pre,code,nav,footer') && !node.querySelector('h1,h2,h3,h4,p,li,td,th'));
      return { title: document.title, blocks: nodes.map((node, i) => ({ id: `source-${i}`, kind: /^H/.test(node.tagName) ? 'heading' : 'text', text: node.innerText.trim() })).filter(block => block.text) };
    });
    assert.ok(document.blocks.length > 10, 'expected a real article body');
    await article.close();
  }
  const results = [];
  for (const scenario of ['normal', 'partial', 'malformed']) {
    for (const mode of compareRef ? ['baseline', 'current'] : ['current']) {
      const key = `${mode}-${scenario}`;
      metrics.set(key, { scenario, requests: 0, active: 0, peak: 0 });
      const context = await browser.newContext();
      try {
        const page = await context.newPage(); await page.goto(origin);
        const report = await page.evaluate(async ({ mode, key, document, origin }) => {
          const { translateBlocks } = await import(`/${mode}/reader-core.js`);
          const { readerStore } = await import(`/${mode}/reader-store.js`);
          const blocks = document.blocks;
          let firstMs;
          const started = performance.now();
          const provider = { baseUrl: `${origin}/model/${key}/v1`, model: 'controlled-latency', apiKey: 'test', language: 'zh-CN' };
          const output = await translateBlocks(provider, document, blocks, {
            onResult: item => {
              firstMs ??= performance.now() - started;
              const p = window.document.createElement('p'); p.dataset.source = item.id; p.textContent = item.text;
              window.document.querySelector('main').append(p);
            },
          });
          const totalMs = performance.now() - started;
          const rendered = window.document.querySelectorAll('main p').length;
          const modelRequests = () => performance.getEntriesByType('resource').filter(entry => entry.name.includes('/chat/completions')).length;
          const beforeCache = modelRequests();
          const cacheStarted = performance.now();
          await translateBlocks(provider, document, blocks);
          return { cacheRequests: modelRequests() - beforeCache, firstMs: Math.round(firstMs), totalMs: Math.round(totalMs), cacheMs: Math.round(performance.now() - cacheStarted), rendered, completed: output.filter(item => item.text && !item.error).length };
        }, { mode, key, document, origin });
        if (document.blocks.length <= 500) assert.equal(report.cacheRequests, 0);
        assert.equal(report.completed, document.blocks.length);
        assert.equal(report.rendered, document.blocks.length);
        assert.ok(metrics.get(key).peak <= 4);
        results.push({ mode, scenario, ...report, ...metrics.get(key) });
      } finally { await context.close(); }
    }
  }
  const report = { articleUrl: articleUrl || 'generated technical article', blocks: document.blocks.length, model: 'controlled: 80ms + 0.15ms/source character', results };
  await writeFile(`${directory}/results.json`, JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ ...report, directory }, null, 2));
} finally { await browser.close(); await new Promise(resolve => server.close(resolve)); }
