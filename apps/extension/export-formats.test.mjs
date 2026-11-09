import test from 'node:test';
import assert from 'node:assert/strict';
import { libraryItems, libraryPage } from './reader-library.js';
import {
  EXPORT_FORMATS,
  exportNotion,
  exportObsidian,
  exportSingleRecord,
  safeFileName,
} from './export-formats.js';

const at = (month, day, hour = 12) => new Date(2026, month - 1, day, hour, 0, 0).toISOString();

function sample() {
  return libraryItems([
    { id: 'older', url: 'https://alpha.test/post', title: 'Alpha page', quote: 'Older evidence',
      note: 'Older note', tags: ['perf'], createdAt: at(11, 1, 9), updatedAt: at(11, 1, 9) },
    { id: 'newer', url: 'https://alpha.test/post', title: 'Alpha page', quote: 'Newer evidence',
      aiAnswer: 'Newer conclusion', createdAt: at(11, 2, 9), updatedAt: at(11, 5, 9) },
    { id: 'other', url: 'https://beta.test/other', title: 'Beta page', quote: 'Beta evidence',
      createdAt: at(11, 3, 9), updatedAt: at(11, 3, 9) },
  ], [{
    id: 'annotation', document: { url: 'https://beta.test/other', title: 'Beta page' },
    anchor: { quote: 'Beta annotation' }, note: 'Annotation note',
    createdAt: at(11, 6, 9), updatedAt: at(11, 6, 9),
  }]);
}

/** Lines between the opening and closing `---` of an Obsidian note. */
function frontmatterOf(content) {
  const match = /^---\n([\s\S]*?)\n---\n/u.exec(content);
  assert.ok(match, 'note starts with a closed frontmatter block');
  return match[1];
}

function deepFreeze(value) {
  if (value && typeof value === 'object') {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

test('EXPORT_FORMATS is frozen and lists every writer the panel can dispatch on', () => {
  assert.equal(Object.isFrozen(EXPORT_FORMATS), true);
  assert.deepEqual([...EXPORT_FORMATS], ['markdown', 'obsidian', 'notion']);
});

test('obsidian groups by page, sorts keys by title and writes frontmatter plus callouts', () => {
  const files = exportObsidian(sample());
  assert.deepEqual(Object.keys(files), ['Reader/Alpha-page.md', 'Reader/Beta-page.md']);

  const alpha = files['Reader/Alpha-page.md'];
  const frontmatter = frontmatterOf(alpha);
  assert.match(frontmatter, /^title: "Alpha page"$/mu);
  assert.match(frontmatter, /^url: "https:\/\/alpha\.test\/post"$/mu);
  assert.match(frontmatter, /^site: "alpha\.test"$/mu);
  // Earliest and latest entry, both rendered as local calendar dates.
  assert.match(frontmatter, /^created: 2026-11-01$/mu);
  assert.match(frontmatter, /^updated: 2026-11-05$/mu);
  assert.match(frontmatter, /^tags:\n  - "perf"$/mu);
  assert.match(frontmatter, /^source: deep-research-reader$/mu);

  assert.match(alpha, /^# Alpha page$/mu);
  assert.match(alpha, /^## 2026-11-05 · 摘录$/mu);
  assert.match(alpha, /^## 2026-11-01 · 摘录$/mu);
  assert.match(alpha, /> \[!quote\]\n> Newer evidence/u);
  assert.match(alpha, /> \[!quote\]\n> Older evidence/u);
  assert.match(alpha, /\*\*我的笔记\*\*：Older note/u);
  assert.match(alpha, /> \[!note\] AI 结论\n> Newer conclusion/u);
  assert.match(alpha, /来源：<https:\/\/alpha\.test\/post>/u);
  // Newest entry first, inside one file.
  assert.ok(alpha.indexOf('Newer evidence') < alpha.indexOf('Older evidence'));
  assert.ok(alpha.indexOf('## 2026-11-05') < alpha.indexOf('## 2026-11-01'));
  assert.equal(alpha.endsWith('\n'), true);
  assert.equal(alpha.endsWith('\n\n'), false);
  assert.equal(alpha.includes('\r'), false);

  const beta = files['Reader/Beta-page.md'];
  assert.match(beta, /^## 2026-11-06 · 标注$/mu);
  assert.match(beta, /^tags: \[\]$/mu);
  // Both entries on one URL share one file and one frontmatter block.
  assert.equal((beta.match(/^---$/gmu) || []).length, 2);
});

test('obsidian escapes quotes, colons, newlines and `---` lines in YAML', () => {
  const title = 'He said "hi":\n---\n# not yaml | pipe';
  const [item] = libraryItems([{
    id: 'yaml', url: 'https://yaml.test/a', title, quote: 'q', createdAt: at(11, 9),
  }], []);
  const [content] = Object.values(exportObsidian([item]));
  const frontmatter = frontmatterOf(content);

  // One quoted scalar: no real newline, so the `---` inside the title cannot
  // close the frontmatter block.
  assert.ok(frontmatter.includes('title: "He said \\"hi\\":\\n---\\n# not yaml | pipe"'));
  assert.equal(frontmatter.split('\n').filter(line => line === '---').length, 0);
  assert.equal(frontmatter.split('\n').filter(line => line.startsWith('title: ')).length, 1);
  // The human-readable H1 flattens the newlines instead.
  assert.match(content, /^# He said "hi": --- # not yaml \| pipe$/mu);
});

test('obsidian neutralises headings, fences, quotes and rules in user text', () => {
  const hostile = libraryItems([{
    id: 'hostile',
    url: 'https://nasty.test/a',
    title: 'Nasty',
    quote: 'before\n```js\nconst x = 1;\n```\n# not a heading\n> already quoted\n---',
    note: '# note heading\n===\n1. not a list\n***\n_ _ _',
    createdAt: at(11, 9),
  }], []);
  const [content] = Object.values(exportObsidian(hostile));
  const lines = content.split('\n');

  assert.equal(lines.some(line => /^\s*```/u.test(line)), false);
  assert.ok(content.includes('> \\# not a heading'));
  assert.ok(content.includes('> \\> already quoted'));
  assert.ok(content.includes('> \\---'));
  assert.ok(content.includes('**我的笔记**：\\# note heading'));
  assert.ok(content.includes('\\==='));
  assert.ok(content.includes('1\\. not a list'));
  assert.ok(content.includes('\\***'));
  assert.ok(content.includes('\\_ _ _'));
  // No horizontal rule leaked from content; only the two frontmatter fences.
  assert.equal(lines.some(line => line !== '---' && /^\s*([-*_]\s*){3,}$/u.test(line)), false);
  assert.equal(lines.filter(line => line === '---').length, 2);
});

test('obsidian gives same-named pages deterministic -2/-3 suffixes', () => {
  const items = libraryItems([
    { id: 'a', url: 'https://a.test/1', title: 'Same title', createdAt: at(11, 1) },
    { id: 'b', url: 'https://b.test/2', title: 'Same title', createdAt: at(11, 2) },
    { id: 'c', url: 'https://c.test/3', title: 'Same title', createdAt: at(11, 3) },
  ], []);
  const files = exportObsidian(items);
  assert.deepEqual(Object.keys(files), [
    'Reader/Same-title.md', 'Reader/Same-title-2.md', 'Reader/Same-title-3.md',
  ]);
  assert.match(files['Reader/Same-title.md'], /url: "https:\/\/a\.test\/1"/u);
  assert.match(files['Reader/Same-title-2.md'], /url: "https:\/\/b\.test\/2"/u);
  assert.match(files['Reader/Same-title-3.md'], /url: "https:\/\/c\.test\/3"/u);

  // Titles that sanitise to the same file name also get a suffix instead of
  // overwriting each other.
  const sanitised = exportObsidian(libraryItems([
    { id: 'x', url: 'https://x.test/1', title: 'A/B', createdAt: at(11, 1) },
    { id: 'y', url: 'https://y.test/2', title: 'A:B', createdAt: at(11, 2) },
  ], []));
  assert.deepEqual(Object.keys(sanitised).sort(), ['Reader/A-B-2.md', 'Reader/A-B.md']);
});

test('obsidian aggregates tags de-duplicated and stably sorted', () => {
  const items = libraryItems([
    { id: 't1', url: 'https://tags.test/page', title: 'Tags page', tags: ['React', 'perf'], createdAt: at(11, 1) },
    { id: 't2', url: 'https://tags.test/page', title: 'Tags page', tags: ['react', 'Alpha Tag', '  '], createdAt: at(11, 2) },
  ], []);
  const files = exportObsidian(items);
  const frontmatter = frontmatterOf(files['Reader/Tags-page.md']);
  const tagLines = frontmatter.split('\n').filter(line => line.startsWith('  - '));
  // Entries are newest-first, so the newest spelling of a duplicate wins.
  const expected = ['Alpha Tag', 'perf', 'react'].sort((first, second) => first.localeCompare(second, 'zh'))
    .map(tag => `  - "${tag}"`);
  assert.deepEqual(tagLines, expected);
  // Case-insensitive de-duplication keeps only one spelling.
  assert.equal(tagLines.filter(line => /react/iu.test(line)).length, 1);
  assert.ok(tagLines.includes('  - "react"'));
  // Sorting and grouping are deterministic across exports.
  assert.deepEqual(exportObsidian(items), files);
});

test('obsidian falls back to hostname and then a neutral untitled page', () => {
  const [hostOnly] = libraryItems([{ id: 'h', url: 'https://fallback.test/a', quote: 'x' }], []);
  const hostFiles = exportObsidian([hostOnly]);
  assert.deepEqual(Object.keys(hostFiles), ['Reader/fallback.test.md']);
  assert.match(hostFiles['Reader/fallback.test.md'], /^title: "fallback\.test"$/mu);

  const [nameless] = libraryItems([{ id: 'n', note: 'x' }], []);
  const namelessFiles = exportObsidian([nameless]);
  assert.deepEqual(Object.keys(namelessFiles), ['Reader/untitled.md']);
  assert.match(namelessFiles['Reader/untitled.md'], /^title: "未标注页面"$/mu);
  assert.match(namelessFiles['Reader/untitled.md'], /^# 未标注页面$/mu);
  // No timestamps means no half-broken date properties.
  assert.equal(namelessFiles['Reader/untitled.md'].includes('created:'), false);
  assert.equal(namelessFiles['Reader/untitled.md'].includes('updated:'), false);
});

test('obsidian keys follow zh collation and accept a custom folder', () => {
  const titles = ['Beta', 'Alpha', '中文页面'];
  const items = libraryItems(titles.map((title, index) => ({
    id: String(index), url: `https://page${index}.test/x`, title, createdAt: at(11, index + 1),
  })), []);
  const expected = [...titles].sort((first, second) => first.localeCompare(second, 'zh'))
    .map(title => `Reader/${title}.md`);
  assert.deepEqual(Object.keys(exportObsidian(items)), expected);

  assert.deepEqual(Object.keys(exportObsidian(sample(), { folder: 'Notes' })),
    ['Notes/Alpha-page.md', 'Notes/Beta-page.md']);
  assert.deepEqual(Object.keys(exportObsidian(sample(), { folder: '/Notes/' })),
    ['Notes/Alpha-page.md', 'Notes/Beta-page.md']);
  assert.deepEqual(Object.keys(exportObsidian(sample(), { folder: '' })),
    ['Reader/Alpha-page.md', 'Reader/Beta-page.md']);
});

test('notion writes one hierarchy without frontmatter and quote lines', () => {
  const notion = exportNotion(sample());
  assert.match(notion, /^# Reader 收藏\n/u);
  assert.equal(notion.startsWith('---'), false);
  assert.equal(/\n---(\n|$)/u.test(notion), false);
  assert.match(notion, /^## Alpha page$/mu);
  assert.match(notion, /^## Beta page$/mu);
  // Notion uses label-first entry headings.
  assert.match(notion, /^### 摘录 · 2026-11-05$/mu);
  assert.match(notion, /^### 摘录 · 2026-11-01$/mu);
  assert.match(notion, /^### 标注 · 2026-11-06$/mu);
  assert.match(notion, /^> Newer evidence$/mu);
  assert.match(notion, /^> Beta annotation$/mu);
  assert.match(notion, /\*\*我的笔记\*\*：Older note/u);
  assert.match(notion, /\*\*AI 结论\*\*：Newer conclusion/u);
  assert.match(notion, /^来源：https:\/\/alpha\.test\/post$/mu);
  // Bare URL, never the Obsidian autolink form.
  assert.equal(notion.includes('<https://'), false);
  assert.ok(notion.indexOf('## Alpha page') < notion.indexOf('## Beta page'));
  assert.ok(notion.indexOf('### 摘录 · 2026-11-05') < notion.indexOf('### 摘录 · 2026-11-01'));
  assert.equal(notion.endsWith('\n'), true);
  assert.equal(notion.endsWith('\n\n'), false);
  assert.equal(notion.includes('\r'), false);
});

test('notion tags, hostile quotes and empty collections stay pasteable', () => {
  const tagged = exportNotion(libraryItems([{
    id: 'n', url: 'https://n.test/1', title: 'Tagged page', quote: 'q', tags: ['two', 'one'], createdAt: at(11, 2),
  }], []));
  assert.match(tagged, /^### 摘录 · 2026-11-02$/mu);
  assert.match(tagged, /^🏷 one, two$/mu);

  const hostile = exportNotion(libraryItems([{
    id: 'h', url: 'https://h.test/1', title: 'Hostile', quote: '---\n# heading\n> quote', note: '---', createdAt: at(11, 2),
  }], []));
  assert.equal(/\n---/u.test(hostile), false);
  assert.match(hostile, /^> \\---$/mu);
  assert.match(hostile, /^> \\# heading$/mu);
  assert.equal(hostile.includes('\n```'), false);

  const empty = '# Reader 收藏\n\n（还没有收藏内容。）\n';
  assert.equal(exportNotion([]), empty);
  assert.equal(exportNotion(null), empty);
  assert.equal(exportNotion(undefined), empty);
  // A custom document title is honoured, but still quoted/escaped.
  assert.equal(exportNotion([], { title: 'My library' }), '# My library\n\n（还没有收藏内容。）\n');
});

test('single record skips empty fields and ends with exactly one newline', () => {
  const [bare] = libraryItems([{
    id: 'bare', url: 'https://alpha.test/bare', title: 'Bare page', quote: 'Quoted',
  }], []);
  const bareOutput = exportSingleRecord(bare);
  assert.equal(bareOutput, '> Quoted\n\n来源：[Bare page](https://alpha.test/bare)\n');
  assert.equal(bareOutput.includes('**我的笔记**'), false);
  assert.equal(bareOutput.includes('**AI 结论**'), false);
  assert.equal(bareOutput.includes('**标签**'), false);
  assert.equal(/\n{3,}/u.test(bareOutput), false);
  assert.equal(bareOutput.endsWith('\n'), true);
  assert.equal(bareOutput.endsWith('\n\n'), false);

  const [full] = libraryItems([{
    id: 'full', url: 'https://alpha.test/full', title: 'Full page', quote: 'Q',
    note: 'N', aiAnswer: 'A', tags: ['two', 'one'],
  }], []);
  assert.equal(exportSingleRecord(full),
    '> Q\n\n**我的笔记**：N\n\n**AI 结论**：A\n\n**标签**：one、two\n\n来源：[Full page](https://alpha.test/full)\n');

  // The annotation shape and the paginated `{ kind, record }` shape normalise
  // to the same snippet as a flat view model.
  const flat = exportSingleRecord(libraryItems([], [{
    id: 'a', document: { url: 'https://a.test/x', title: 'A page' }, anchor: { quote: 'Q' }, note: 'N',
  }])[0]);
  const paged = exportSingleRecord({
    kind: 'annotation',
    record: { id: 'a', document: { url: 'https://a.test/x', title: 'A page' }, anchor: { quote: 'Q' }, note: 'N' },
  });
  assert.equal(paged, flat);
  assert.match(paged, /^> Q\n\n\*\*我的笔记\*\*：N\n\n来源：\[A page\]\(https:\/\/a\.test\/x\)\n$/u);
});

test('single record tolerates null and empty records without blank paragraphs', () => {
  for (const empty of [null, undefined, 0, '', 'text', {}]) {
    assert.equal(exportSingleRecord(empty), '（没有可复制的条目。）\n');
  }
  const [noteOnly] = libraryItems([{ id: 'n', url: 'https://n.test/x', title: 'Note page', note: 'Only a note' }], []);
  const noteOutput = exportSingleRecord(noteOnly);
  assert.match(noteOutput, /^\*\*我的笔记\*\*：Only a note\n\n来源：/u);
  assert.equal(noteOutput.includes('> '), false);
  // An item without a source still exports its text and no dangling link.
  const [noUrl] = libraryItems([{ id: 'u', quote: 'Loose quote' }], []);
  assert.equal(exportSingleRecord(noUrl), '> Loose quote\n');
});

test('safeFileName keeps Chinese, replaces illegal characters and truncates by code point', () => {
  assert.equal(safeFileName('中文 标题'), '中文-标题');
  assert.equal(safeFileName('a/b\\c:d*e?f"g<h>i|j'), 'a-b-c-d-e-f-g-h-i-j');
  assert.equal(safeFileName('a\u0000b\u001fc\u007fd'), 'a-b-c-d');
  assert.equal(safeFileName('a   b'), 'a-b');
  assert.equal(safeFileName('a---b'), 'a-b');
  assert.equal(safeFileName('.gitignore'), 'gitignore');
  assert.equal(safeFileName('report. '), 'report');
  assert.equal(safeFileName('  ...  '), 'untitled');
  assert.equal(safeFileName('---'), 'untitled');
  assert.equal(safeFileName(''), 'untitled');
  assert.equal(safeFileName(null), 'untitled');
  assert.equal(safeFileName(undefined), 'untitled');
  assert.equal(safeFileName('', '未命名'), '未命名');
  assert.equal(safeFileName('...', '未命名'), '未命名');

  const long = safeFileName('字'.repeat(120));
  assert.equal([...long].length, 80);
  const emoji = safeFileName('😀'.repeat(120));
  // 80 code points, not 80 UTF-16 units: surrogate pairs stay intact.
  assert.equal([...emoji].length, 80);
  assert.equal(emoji, '😀'.repeat(80));
});

test('writers are pure, deterministic and never mutate or throw on partial records', () => {
  const items = sample();
  const snapshot = JSON.stringify(items);
  deepFreeze(items);
  assert.doesNotThrow(() => {
    exportObsidian(items);
    exportNotion(items);
    exportSingleRecord(items[0]);
    safeFileName(items[0].title);
  });
  assert.equal(JSON.stringify(items), snapshot);

  for (const weird of [null, undefined, 0, '', 'text', {}, { kind: 'mystery' }, [{}, null, 3]]) {
    assert.doesNotThrow(() => exportObsidian(weird));
    assert.doesNotThrow(() => exportNotion(weird));
    assert.doesNotThrow(() => exportSingleRecord(weird));
    assert.doesNotThrow(() => safeFileName(weird));
  }
  // An unknown record type still gets a label rather than an empty heading,
  // and a prototype-like kind cannot resolve to Object.prototype.
  for (const kind of ['mystery', '__proto__', 'constructor']) {
    assert.match(exportNotion([{ kind, id: 'm', url: '' }]), /^### 条目$/mu);
    assert.match(Object.values(exportObsidian([{ kind, id: 'm', url: '' }]))[0], /^## 条目$/mu);
  }
});

test('flat items and paginated library entries export identical files', () => {
  const insights = [
    { id: 'i1', url: 'https://alpha.test/a', title: 'Alpha', quote: 'Evidence', createdAt: at(11, 1), updatedAt: at(11, 2) },
    { id: 'i2', url: 'https://beta.test/b', title: 'Beta', createdAt: at(11, 3) },
  ];
  const annotations = [{
    id: 'a1', document: { url: 'https://beta.test/b', title: 'Beta' },
    anchor: { quote: 'Annotated' }, createdAt: at(11, 4),
  }];
  assert.deepEqual(exportObsidian(libraryPage(insights, annotations).items), exportObsidian(libraryItems(insights, annotations)));
  assert.equal(exportNotion(libraryPage(insights, annotations).items), exportNotion(libraryItems(insights, annotations)));
});
