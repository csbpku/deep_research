import { createServer } from 'node:http';
import { cp, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { chromium } from '../../web/node_modules/@playwright/test/index.mjs';
import { tempPath } from './temp-paths.mjs';
import assert from 'node:assert/strict';

// The saved-items shelf must stay usable once it grows: tags narrow the list
// without re-reading storage, and the Markdown export is a real file the user
// can drop into an existing notes workflow.
const extensionPath = `${await mkdtemp(tempPath('reader-library-extension-'))}/extension`;
await cp(new URL('../.output/chrome-mv3', import.meta.url), extensionPath, { recursive: true });
const manifestPath = `${extensionPath}/manifest.json`;
const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
manifest.host_permissions = [...new Set([...(manifest.host_permissions || []), 'http://127.0.0.1/*'])];
await writeFile(manifestPath, JSON.stringify(manifest));

const fixture = await readFile(new URL('./fixture.html', import.meta.url));
const server = createServer((request, response) => {
  if (request.url === '/fixture.html') {
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    response.end(fixture);
    return;
  }
  response.writeHead(404);
  response.end('not found');
});
await new Promise((resolve, reject) => {
  server.once('error', reject);
  server.listen(8898, '127.0.0.1', resolve);
});

const executablePath = process.env.CHROME_FOR_TESTING || [
  '/Users/shaobo.chen/Library/Caches/ms-playwright/chromium-1234/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
].find(existsSync);
if (!executablePath) throw new Error('找不到 Chrome，请设置 CHROME_FOR_TESTING');

const context = await chromium.launchPersistentContext(tempPath(`reader-library-profile-${Date.now()}`), {
  executablePath,
  headless: process.env.READER_HEADLESS === '1',
  viewport: { width: 400, height: 900 },
  args: [
    '--enable-extensions',
    `--disable-extensions-except=${extensionPath}`,
    `--load-extension=${extensionPath}`,
    '--no-first-run',
    '--no-default-browser-check',
  ],
});

try {
  const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
  const extensionId = new URL(worker.url()).host;
  await worker.evaluate(() => chrome.storage.local.set({ readerUiLanguage: 'zh-CN' }));

  const panel = await context.newPage();
  await panel.goto(`chrome-extension://${extensionId}/sidepanel.html`, { waitUntil: 'domcontentloaded' });
  await panel.waitForFunction(() => document.documentElement.dataset.readerReady === 'true');

  await panel.evaluate(async () => {
    const records = [
      { id: 'a1', url: 'https://example.com/a', title: 'Alpha guide', quote: 'Bounded queues keep work responsive.', note: '', aiAnswer: '', tags: ['架构', '性能'], createdAt: '2026-11-01T02:00:00.000Z', updatedAt: '2026-11-01T02:00:00.000Z' },
      { id: 'b1', url: 'https://docs.example.org/b', title: 'Beta reference', quote: 'Cancellation stops stale requests.', note: '待验证', aiAnswer: '', tags: ['架构'], createdAt: '2026-11-02T02:00:00.000Z', updatedAt: '2026-11-02T02:00:00.000Z' },
      { id: 'c1', url: 'https://blog.example.net/c', title: 'Gamma notes', quote: 'Backpressure moves cost upstream.', note: '', aiAnswer: '容量决定延迟', tags: ['性能'], createdAt: '2026-11-03T02:00:00.000Z', updatedAt: '2026-11-03T02:00:00.000Z' },
    ];
    await new Promise((resolve, reject) => {
      const request = indexedDB.open('deep-research-reader', 4);
      request.onupgradeneeded = () => {
        const database = request.result;
        ['sessions', 'insights', 'annotations', 'settings', 'cache', 'jobs', 'taskInputs']
          .forEach((name) => { if (!database.objectStoreNames.contains(name)) database.createObjectStore(name, { keyPath: 'id' }); });
      };
      request.onsuccess = () => {
        const database = request.result;
        const transaction = database.transaction('insights', 'readwrite');
        records.forEach((record) => transaction.objectStore('insights').put(record));
        transaction.oncomplete = () => { database.close(); resolve(); };
        transaction.onerror = () => reject(transaction.error);
      };
      request.onerror = () => reject(request.error);
    });
  });

  await panel.reload({ waitUntil: 'domcontentloaded' });
  await panel.waitForFunction(() => document.documentElement.dataset.readerReady === 'true');

  // The shelf lives inside the page view, so a readable tab has to exist.
  const article = await context.newPage();
  await article.goto('http://127.0.0.1:8898/fixture.html', { waitUntil: 'domcontentloaded' });
  await article.bringToFront();
  await worker.evaluate(async () => {
    const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    if (!tab?.id) throw new Error('fixture tab is not active');
    await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['content.js'] });
    await chrome.tabs.sendMessage(tab.id, { type: 'deep-research:request-page' });
  });
  await panel.waitForFunction(() => document.querySelector('#page-view') && !document.querySelector('#page-view').classList.contains('hidden'), null, { timeout: 10_000 });

  await panel.locator('#nav-library').click();
  await panel.locator('.insight-row').first().waitFor({ state: 'visible', timeout: 10_000 });
  assert.equal(await panel.locator('.insight-row').count(), 3, '收藏列表应显示全部三条');

  const tagOptions = await panel.locator('#library-tag option').evaluateAll((options) => options.map((option) => ({ value: option.value, text: option.textContent })));
  assert.ok(tagOptions.some((option) => option.value === '架构' && /2/.test(option.text)), `标签分面应包含“架构（2 条）”：${JSON.stringify(tagOptions)}`);
  assert.ok(tagOptions.some((option) => option.value === '性能' && /2/.test(option.text)), `标签分面应包含“性能（2 条）”：${JSON.stringify(tagOptions)}`);

  await panel.locator('#library-tag').selectOption('架构');
  await panel.waitForFunction(() => document.querySelectorAll('.insight-row').length === 2, null, { timeout: 10_000 });
  const filteredText = await panel.locator('#library-list').innerText();
  assert.ok(filteredText.includes('Alpha guide') && filteredText.includes('Beta reference'), '标签筛选应保留两条“架构”记录');
  assert.equal(filteredText.includes('Gamma notes'), false, '标签筛选不应保留其他标签的记录');
  assert.equal(await panel.locator('#clear-library-filters').isVisible(), true, '有筛选时应显示清除入口');

  await panel.locator('#library-search').fill('待验证');
  await panel.waitForFunction(() => document.querySelectorAll('.insight-row').length === 1, null, { timeout: 10_000 });
  assert.match(await panel.locator('#library-summary').innerText(), /1/);

  await panel.locator('#clear-library-filters').click();
  await panel.waitForFunction(() => document.querySelectorAll('.insight-row').length === 3, null, { timeout: 10_000 });

  const downloadPromise = panel.waitForEvent('download');
  await panel.locator('#library-export').click();
  const download = await downloadPromise;
  assert.match(download.suggestedFilename(), /^reader-library-\d{4}-\d{2}-\d{2}\.md$/u, `导出文件名应以日期结尾：${download.suggestedFilename()}`);
  const stream = await download.createReadStream();
  const chunks = [];
  for await (const chunk of stream) chunks.push(chunk);
  const markdown = Buffer.concat(chunks).toString('utf8');
  for (const expected of ['# Reader 收藏', '## Alpha guide', '> Bounded queues keep work responsive.', '**标签**', '来源：<https://example.com/a>', '**我的笔记**', '**AI 结论**']) {
    assert.ok(markdown.includes(expected), `Markdown 缺少“${expected}”:\n${markdown.slice(0, 400)}`);
  }
  assert.equal(markdown.endsWith('\n') && !markdown.endsWith('\n\n'), true, 'Markdown 应以单个换行结束');

  // Tag maintenance edits every matching record in place; it must not delete
  // the saved content or reorder the shelf by touching updatedAt.
  await panel.locator('#manage-tags').click();
  await panel.locator('#tag-manager').waitFor({ state: 'visible', timeout: 10_000 });
  assert.equal(await panel.locator('.tag-manager-row').count(), 2, '标签管理应列出全库两个标签');
  await panel.locator('.tag-manager-row[data-tag="架构"] input').fill('系统设计');
  await panel.locator('.tag-manager-row[data-tag="架构"]').getByRole('button', { name: '保存', exact: true }).click();
  await panel.waitForFunction(() => [...document.querySelectorAll('#library-tag option')].some(option => option.value === '系统设计'), null, { timeout: 10_000 });
  assert.equal(await panel.locator('#library-tag option[value="架构"]').count(), 0, '旧标签不应残留');
  assert.match(await panel.locator('#library-list').innerText(), /Alpha guide/, '重命名后收藏仍在原处');

  await panel.locator('.tag-manager-row[data-tag="性能"]').getByRole('button', { name: '删除', exact: true }).click();
  await panel.locator('.tag-manager-row[data-tag="性能"]').getByRole('button', { name: '确认删除', exact: true }).click();
  await panel.waitForFunction(() => [...document.querySelectorAll('#library-tag option')].every(option => option.value !== '性能'), null, { timeout: 10_000 });
  assert.equal(await panel.locator('.insight-row').count(), 3, '删除标签必须保留收藏内容');
  assert.equal(await panel.locator('.tag-manager-row').count(), 1, '标签管理应只剩重命名后的标签');

  console.log(JSON.stringify({
    ok: true,
    checks: [
      'the shelf lists every saved record before filtering',
      'tag facets carry counts for the whole shelf',
      'choosing a tag narrows the list without dropping search',
      'clearing filters restores the full list',
      'the Markdown export downloads a dated file with grouped pages, notes, tags and sources',
      'tag rename updates every matching record and tag delete keeps the records',
    ],
    tags: tagOptions.filter((option) => option.value).map((option) => option.value),
    markdownBytes: Buffer.byteLength(markdown),
  }, null, 2));
} finally {
  await context.close();
  server.close();
}
