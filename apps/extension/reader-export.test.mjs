import test from 'node:test';
import assert from 'node:assert/strict';
import { libraryItems, libraryPage } from './reader-library.js';
import { libraryFileName, libraryMarkdown } from './reader-export.js';

const markdownLines = markdown => markdown.split('\n');
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

test('pages are grouped by URL, newest group first, newest entry first inside a group', () => {
  const markdown = libraryMarkdown(sample(), { generatedAt: '2026-11-09T08:00:00.000Z' });
  const lines = markdownLines(markdown);
  assert.equal(lines[0], '# Reader 收藏');
  assert.ok(lines.includes('- 生成时间：2026-11-09T08:00:00.000Z'));
  assert.ok(lines.includes('- 条目数：4'));

  const headings = lines.filter(line => line.startsWith('## '));
  assert.deepEqual(headings, ['## Beta page', '## Alpha page']);
  // Beta's newest entry (Nov 6) beats Alpha's (Nov 5), so Beta's page leads.
  assert.ok(markdown.indexOf('## Beta page') < markdown.indexOf('## Alpha page'));

  // Inside the Alpha page the Nov 5 entry must precede the Nov 1 one.
  const alpha = markdown.slice(markdown.indexOf('## Alpha page'));
  assert.ok(alpha.indexOf('Newer evidence') < alpha.indexOf('Older evidence'));
  // And the older Alpha entry comes after the page heading, not before it.
  assert.ok(alpha.indexOf('Older evidence') > 0);

  // Both records on the Beta page share one grouping heading.
  assert.equal(headings.filter(heading => heading === '## Beta page').length, 1);
  assert.equal(lines.filter(line => line.startsWith('### 收藏')).length, 3);
  assert.equal(lines.filter(line => line.startsWith('### 标注')).length, 1);
  // Local wall-clock stamps, not raw UTC.
  assert.ok(lines.some(line => line === '### 收藏 · 2026-11-05 09:00'), 'entry stamp uses local time');
});

test('quotes cannot open a fence, a heading or an escaping blockquote', () => {
  const hostile = libraryItems([{
    id: 'hostile',
    url: 'https://alpha.test/hostile',
    title: 'Hostile input',
    quote: 'before\n```js\nconst x = 1;\n```\n# not a heading\n> already quoted\n- not a list\n===',
    note: '# not a heading either\n```\nstill a fence\n```',
    aiAnswer: 'pipe | inside table-ish text',
    tags: ['a|b', '`tick`'],
    createdAt: at(11, 9),
  }], []);
  const markdown = libraryMarkdown(hostile, { generatedAt: '2026-11-09T08:00:00.000Z' });
  const lines = markdownLines(markdown);

  // No line can start a fence: every collected line sits inside the blockquote.
  assert.equal(lines.some(line => /^\s*```/u.test(line)), false);
  assert.equal(lines.some(line => /^\s*~~~\s*$/u.test(line)), false);
  assert.match(markdown, /> \\`\\`\\`js/u);
  assert.match(markdown, /> \\# not a heading/u);
  assert.match(markdown, /> \\> already quoted/u);
  assert.match(markdown, /> \\- not a list/u);
  // An all-`=` line would turn the line above it into a setext heading.
  assert.equal(lines.includes('> ==='), false);
  assert.match(markdown, /> &#61;&#61;&#61;/u);
  // Notes are prose, so their `#` never becomes a document heading.
  assert.equal(lines.includes('# not a heading either'), false);
  assert.match(markdown, /\\# not a heading either/u);

  // Only the headings this function writes exist, at the depths it writes them.
  const headings = lines.filter(line => /^#{1,6}(\s|$)/u.test(line));
  assert.deepEqual(headings.map(line => line.split(' ')[0]), ['#', '##', '###']);
  // Structure still holds: headings first, then the blockquote, then the labels.
  assert.ok(markdown.indexOf('## Hostile input') < markdown.indexOf('> before'));
  assert.ok(markdown.indexOf('**我的笔记**') < markdown.indexOf('**AI 结论**'));
  // No stray horizontal rule or list marker sneaks in from the content.
  assert.equal(lines.some(line => /^(-{3,}|\*{3,}|_{3,})$/u.test(line)), false);
  assert.equal(lines.filter(line => /^- /u.test(line)).length, 2, 'only the two metadata bullets');
});

test('an empty collection still exports a usable document', () => {
  for (const input of [[], undefined, null]) {
    const markdown = libraryMarkdown(input, { generatedAt: '2026-11-09T08:00:00.000Z' });
    assert.equal(typeof markdown, 'string');
    assert.ok(markdown.length > 0);
    assert.match(markdown, /^# Reader 收藏\n/u);
    assert.match(markdown, /条目数：0/u);
    assert.match(markdown, /还没有收藏内容/u);
    assert.equal(markdown.split('\n').filter(line => line.startsWith('## ')).length, 0);
    assert.equal(markdown.endsWith('\n'), true);
    assert.equal(markdown.endsWith('\n\n'), false);
    assert.equal(markdown.includes('\r'), false);
  }
});

test('entries without a quote, note, answer or tags skip those blocks', () => {
  const [bare] = libraryItems([{ id: 'bare', url: 'https://alpha.test/bare', title: 'Bare page', createdAt: at(11, 7) }], []);
  const markdown = libraryMarkdown([bare], { generatedAt: '2026-11-09T08:00:00.000Z' });
  assert.equal(markdown.includes('**我的笔记**'), false);
  assert.equal(markdown.includes('**AI 结论**'), false);
  assert.equal(markdown.includes('**标签**'), false);
  assert.equal(markdownLines(markdown).some(line => line.startsWith('>')), false, 'no empty blockquote for a missing quote');
  assert.match(markdown, /^### 收藏 · 2026-11-07 12:00$/mu);
  assert.match(markdown, /来源：<https:\/\/alpha\.test\/bare>/u);
  // A record with no URL is still exported, under a neutral heading.
  const [orphan] = libraryItems([{ id: 'orphan', title: 'No source', note: 'orphan note' }], []);
  const orphanMarkdown = libraryMarkdown([orphan], { generatedAt: '2026-11-09T08:00:00.000Z' });
  assert.match(orphanMarkdown, /^## No source$/mu);
  assert.match(orphanMarkdown, /来源：（无原文链接）/u);
  assert.match(orphanMarkdown, /orphan note/u);
  // Neither a title nor a URL leaves a neutral heading instead of a broken one.
  const nameless = libraryMarkdown(libraryItems([{ id: 'nameless' }], []), { generatedAt: '2026-11-09T08:00:00.000Z' });
  assert.match(nameless, /^## 未标注页面$/mu);
  assert.match(nameless, /^### 收藏$/mu);
  // An unknown record type still gets a label instead of an empty heading.
  assert.match(libraryMarkdown([{ kind: 'mystery', id: 'm', url: '' }], { generatedAt: '2026-11-09T08:00:00.000Z' }),
    /^### 条目$/mu);
});

test('the paginated { kind, record } entries export the same document as flat items', () => {
  const insights = [
    { id: 'i1', url: 'https://alpha.test/a', title: 'Alpha', quote: 'Evidence', createdAt: at(11, 1), updatedAt: at(11, 2) },
    { id: 'i2', url: 'https://beta.test/b', title: 'Beta', createdAt: at(11, 3) },
  ];
  const annotations = [{ id: 'a1', document: { url: 'https://beta.test/b', title: 'Beta' },
    anchor: { quote: 'Annotated' }, createdAt: at(11, 4) }];
  const flat = libraryMarkdown(libraryItems(insights, annotations), { generatedAt: '2026-11-09T08:00:00.000Z' });
  const paged = libraryMarkdown(libraryPage(insights, annotations).items, { generatedAt: '2026-11-09T08:00:00.000Z' });
  assert.equal(paged, flat);
  assert.match(paged, /### 标注 · 2026-11-04 12:00/u);
});

test('the document ends with exactly one newline and uses \\n only', () => {
  const markdown = libraryMarkdown(sample(), { generatedAt: '2026-11-09T08:00:00.000Z' });
  assert.equal(markdown.includes('\r'), false);
  assert.equal(markdown.endsWith('\n'), true);
  assert.equal(markdown.endsWith('\n\n'), false);
  assert.equal(/\n{3,}/u.test(markdown), false, 'no accidental blank-line runs');
  // Default generatedAt is the current instant, so the header is never empty.
  assert.match(libraryMarkdown([]), /生成时间：\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z/u);
  // A Date is accepted for the same slot.
  assert.match(libraryMarkdown([], { generatedAt: new Date('2026-11-09T08:00:00.000Z') }),
    /生成时间：2026-11-09T08:00:00.000Z/u);
});

test('libraryFileName stamps the local date and sanitises the prefix', () => {
  assert.match(libraryFileName(), /^reader-library-\d{4}-\d{2}-\d{2}\.md$/u);
  assert.equal(libraryFileName('reader-library', new Date(2026, 10, 9, 23, 30)), 'reader-library-2026-11-09.md');
  // Local time, not UTC: a late-evening export keeps its own calendar day.
  assert.equal(libraryFileName('reader-library', new Date(2026, 0, 2, 0, 5)), 'reader-library-2026-01-02.md');
  assert.equal(libraryFileName('notes', new Date(2026, 10, 9)), 'notes-2026-11-09.md');
  // Path separators and control characters can never escape the download name.
  assert.equal(libraryFileName('a/b:c', new Date(2026, 10, 9)), 'a-b-c-2026-11-09.md');
  assert.equal(libraryFileName('', new Date(2026, 10, 9)), 'reader-library-2026-11-09.md');
  // An unusable date falls back to today instead of producing NaN in the name.
  assert.equal(libraryFileName('reader-library', new Date('nope')), libraryFileName());
  const today = new Date();
  const pad = value => String(value).padStart(2, '0');
  assert.equal(libraryFileName(), `reader-library-${today.getFullYear()}-${pad(today.getMonth() + 1)}-${pad(today.getDate())}.md`);
});
