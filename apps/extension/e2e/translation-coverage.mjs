import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { chromium } from '../../web/node_modules/@playwright/test/index.mjs';

const executablePath = process.env.CHROME_FOR_TESTING || [
  '/Users/shaobo.chen/Library/Caches/ms-playwright/chromium-1234/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
].find(existsSync);
const browser = await chromium.launch({ executablePath, headless: true });
try {
  const page = await browser.newPage();
  const fixturePath = process.env.READER_README_FIXTURE;
  const article = fixturePath ? readFileSync(fixturePath, 'utf8').match(/<article[\s\S]*?<\/article>/u)[0]
    : '<article class="markdown-body"><h1>Article heading</h1><p>First paragraph.</p><ul><li>Outer item<ul><li>Nested item</li></ul></li></ul><h6>Small heading</h6><pre>npm install reader</pre><p>Last paragraph.</p><div class="sd-band"><b>03</b><div><h2>Build</h2><div id="raw-paragraph">Nothing is implemented without an accepted plan. Institutional knowledge becomes files the agent reads, and the guardrails run as code rather than as habits.</div></div></div><div><p>Do not duplicate this nested paragraph.</p></div><div><button>Never collect this control text</button></div><form><div>Never collect private form content.</div></form></article>';
  await page.route('https://github.com/morluto/rea', route => route.fulfill({ contentType: 'text/html', body: `<main><p id="metadata">Files updated yesterday</p>${article}<p>Footer controls</p></main>` }));
  await page.goto('https://github.com/morluto/rea');
  await page.evaluate(() => {
    document.querySelectorAll('img,svg,[data-deep-research-translation]').forEach(node => node.remove());
    document.querySelectorAll('[data-deep-research-block]').forEach(node => node.removeAttribute('data-deep-research-block'));
    window.__messages = [];
    window.chrome = { runtime: { sendMessage: async message => window.__messages.push(message.payload), onMessage: { addListener: handler => { window.__handler = handler; } } }, storage: { local: { get: async () => ({}) }, onChanged: { addListener() {} } } };
  });
  await page.addScriptTag({ path: new URL('../content.js', import.meta.url).pathname });
  async function snapshot() {
    await page.evaluate(() => { window.__messages = []; window.__handler({ type: 'deep-research:request-full-document' }); });
    await page.waitForFunction(() => window.__messages.some(m => m?.type === 'deep-research:full-document'));
    return page.evaluate(() => window.__messages.find(m => m?.type === 'deep-research:full-document').context);
  }
  async function apply(translations) {
    return page.evaluate(translations => new Promise(resolve => window.__handler({ type: 'deep-research:apply-translations', documentUrl: location.href, translations }, {}, resolve)), translations);
  }
  const initial = await snapshot();
  assert.ok(initial.blocks.length > 5);
  assert.ok(!initial.body.includes('Files updated yesterday') && !initial.body.includes('Footer controls'), 'only the README is article content');
  await page.evaluate(() => { window.__messages = []; document.querySelector('#metadata').textContent = 'Files updated just now'; });
  await page.waitForTimeout(650);
  assert.equal(await page.evaluate(() => window.__messages.filter(m => m?.type === 'deep-research:page-context').length), 0, 'repository metadata cannot invalidate README translations');
  if (!fixturePath) {
    assert.equal(initial.blocks.filter(block => block.text.startsWith('Nothing is implemented')).length, 1, 'plain div paragraphs included exactly once');
    assert.equal(initial.blocks.filter(block => block.text.includes('Do not duplicate')).length, 1);
    assert.ok(!initial.body.includes('Never collect'));
  }
  const blocks = initial.blocks.filter(block => block.kind !== 'code');
  const translated = blocks.map(block => ({ id: block.id, sourceText: block.text, text: `译文 ${block.id}` }));
  const receipt = await apply(translated);
  assert.deepEqual(receipt.failedItems, []);
  assert.equal(receipt.appliedIds.length, blocks.length);
  const next = await snapshot();
  assert.equal(next.contentHash, initial.contentHash, 'injected translations preserve source identity');
  assert.equal(next.translatedBlockIds.length, blocks.length);
  await page.evaluate(id => document.querySelector(`[data-deep-research-translation-for="${id}"]`).remove(), translated[0].id);
  assert.deepEqual((await apply([translated[0]])).appliedIds, [translated[0].id], 'cached translation repairs a missing overlay');
  const replay = await apply(translated);
  assert.equal(replay.appliedIds.length, blocks.length, 'all cached translations remain confirmed');
  await page.evaluate(id => { document.querySelector(`[data-deep-research-block="${id}"]`).textContent = 'Changed source passage'; }, translated.at(-1).id);
  const changed = await apply([translated.at(-1), { id: 'removed-block', sourceText: 'Removed', text: '已删除' }]);
  assert.equal(changed.appliedIds.length, 0);
  assert.equal(changed.failedItems.length, 2, 'changed and removed passages are explicit failures');
  console.log(JSON.stringify({ fixture: fixturePath || 'nested GitHub README', blocks: initial.blocks.length, translated: blocks.length, codeBlocks: initial.blocks.length - blocks.length, metadataIgnored: true, sourceHashStable: true, missingOverlayRepaired: true, changedPassagesRejected: changed.failedItems.length }));
} finally { await browser.close(); }
