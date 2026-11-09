/**
 * Markdown export for the local Reader library.
 *
 * Escaping here is structural, not cosmetic: saved quotes are copied out of
 * documentation and frequently contain fenced code, `#` headings and `>`
 * quotes. Emitting them verbatim would change the shape of the exported
 * document (a stray ``` opens a fence and swallows the rest of the file), so
 * every user-controlled string is neutralised before it lands in a heading,
 * paragraph or blockquote. Everything in this module is a pure function: no
 * storage, no clock reads beyond the documented defaults.
 */

import { libraryEntry } from './reader-library.js';

const TYPE_LABELS = { insight: '收藏', annotation: '标注' };
const UNKNOWN_TYPE_LABEL = '条目';
const UNTITLED_PAGE = '未标注页面';
const EMPTY_COLLECTION_NOTE = '（还没有收藏内容。）';

/** Fenced code is the one construct a single backtick cannot be escaped out of. */
function escapeInline(text) {
  // `|` is deliberately left alone: this writer never emits a table, so a pipe
  // in a note stays literal text instead of gaining a visible backslash.
  return String(text ?? '')
    .replace(/\\/gu, '\\\\')
    // Only ambiguous ampersands are rewritten: escaping every `&` would turn a
    // readable "R&D" into noise in the raw file.
    .replace(/&(?=#?[A-Za-z0-9]+;)/gu, '&amp;')
    .replace(/</gu, '&lt;')
    .replace(/`{3,}/gu, match => match.replace(/`/gu, '\\`'));
}

/**
 * A block-level line can still start a heading, list, quote or setext underline
 * even after inline escaping, so leading block markers get a backslash. `=`
 * has no backslash escape in CommonMark, so an all-`=` line is entity encoded.
 */
function escapeLine(line) {
  const indent = line.match(/^\s*/u)[0];
  let body = line.slice(indent.length);
  if (/^#{1,6}(\s|$)/u.test(body) || /^>/u.test(body)) body = `\\${body}`;
  else if (/^[-+*](\s|$)/u.test(body)) body = `\\${body}`;
  else if (/^\d{1,9}[.)](\s|$)/u.test(body)) body = body.replace(/^(\d{1,9})([.)])/u, '$1\\$2');
  else if (/^=+$/u.test(body)) body = body.replace(/=/gu, '&#61;');
  // Indented code needs four spaces; clamping keeps note indentation visible
  // without turning it into a code block inside the blockquote.
  return `${indent.length > 3 ? '   ' : indent}${body}`;
}

/** Render a free-text value as prose: inline escapes, then per-line markers. */
function text(value) {
  return escapeInline(value)
    .split(/\r?\n/u)
    .map(line => escapeLine(line.replace(/\s+$/u, '')))
    .join('\n');
}

/** Same escaping for one-line slots (headings, labels) with newlines flattened. */
function inline(value) {
  return escapeInline(String(value ?? '').replace(/[\r\n]+/gu, ' ').trim());
}

/** Blockquote every line so a quote can never escape the quote it lives in. */
function blockquote(value) {
  return text(value).split('\n').map(line => (line ? `> ${line}` : '>')).join('\n');
}

function timestampOf(value) {
  return Date.parse(String(value ?? ''));
}

/** Local wall-clock stamp: the export is read by the person who saved the item. */
function localStamp(value) {
  const time = timestampOf(value);
  if (Number.isNaN(time)) return '';
  const date = new Date(time);
  const pad = number => String(number).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function hostnameOf(url) {
  try {
    return new URL(String(url)).hostname;
  } catch {
    return '';
  }
}

function itemTime(item) {
  return String(item?.updatedAt || item?.createdAt || '');
}

/**
 * Groups are ordered by their newest item and then by URL, so the same
 * collection always exports the same file. Entries inside a group are newest
 * first, matching how the panel reads.
 */
function groupByPage(entries) {
  const groups = new Map();
  for (const item of entries) {
    const url = String(item?.url || '').trim();
    if (!groups.has(url)) groups.set(url, { url, items: [] });
    groups.get(url).items.push(item);
  }
  const compare = (a, b) => itemTime(b).localeCompare(itemTime(a))
    || `${a.kind}:${a.id}`.localeCompare(`${b.kind}:${b.id}`);
  const result = [...groups.values()];
  for (const group of result) group.items.sort(compare);
  return result.sort((a, b) => itemTime(b.items[0]).localeCompare(itemTime(a.items[0])) || a.url.localeCompare(b.url));
}

function pageTitle(group) {
  const titled = group.items.find(item => typeof item?.title === 'string' && item.title.trim());
  return titled ? titled.title.trim() : hostnameOf(group.url) || group.url || UNTITLED_PAGE;
}

/** `<url>` autolinks break on whitespace, angle brackets and backticks. */
function sourceLine(url) {
  const value = String(url ?? '').trim();
  if (!value) return '来源：（无原文链接）';
  return /^https?:\/\/[^\s<>`]+$/iu.test(value) ? `来源：<${value}>` : `来源：${inline(value)}`;
}

function entryLines(item) {
  const label = TYPE_LABELS[item?.kind] || UNKNOWN_TYPE_LABEL;
  const stamp = localStamp(itemTime(item));
  const lines = ['', `### ${label}${stamp ? ` · ${stamp}` : ''}`, ''];
  if (item?.quote) lines.push(blockquote(item.quote), '');
  if (item?.note) lines.push(`**我的笔记**：${text(item.note)}`, '');
  if (item?.aiAnswer) lines.push(`**AI 结论**：${text(item.aiAnswer)}`, '');
  const tags = (Array.isArray(item?.tags) ? item.tags : []).filter(tag => typeof tag === 'string' && tag.trim());
  if (tags.length) lines.push(`**标签**：${tags.map(tag => inline(tag)).join('、')}`, '');
  lines.push(sourceLine(item?.url), '');
  return lines;
}

export function libraryMarkdown(items, { title = 'Reader 收藏', generatedAt = new Date().toISOString() } = {}) {
  // libraryEntry() accepts both the flat view model and the `{ kind, record }`
  // entries libraryPage() returns, so wiring the panel to the paginated list
  // cannot produce blank rows.
  const entries = (Array.isArray(items) ? items : []).filter(Boolean).map(libraryEntry);
  const generated = generatedAt instanceof Date ? generatedAt.toISOString() : String(generatedAt ?? '').trim();
  const lines = [
    `# ${inline(title) || 'Reader 收藏'}`,
    '',
    `- 生成时间：${inline(generated) || '未知'}`,
    `- 条目数：${entries.length}`,
    '',
  ];
  if (!entries.length) lines.push(EMPTY_COLLECTION_NOTE, '');
  for (const group of groupByPage(entries)) {
    lines.push(`## ${inline(pageTitle(group))}`, '');
    for (const item of group.items) lines.push(...entryLines(item));
  }
  // Exactly one trailing newline, always `\n`, never a blank tail.
  return `${lines.join('\n').replace(/\n{3,}/gu, '\n\n').trimEnd()}\n`;
}

/** Local-time file name so two exports on the same day never overwrite silently. */
export function libraryFileName(prefix = 'reader-library', date = new Date()) {
  const value = date instanceof Date && !Number.isNaN(date.getTime()) ? date : new Date();
  // Strip anything a file system (or a download sandbox) would refuse.
  const base = String(prefix ?? '').trim().replace(/[\\/:*?"<>|\u0000-\u001f]+/gu, '-').replace(/^-+|-+$/gu, '') || 'reader-library';
  const pad = number => String(number).padStart(2, '0');
  return `${base}-${value.getFullYear()}-${pad(value.getMonth() + 1)}-${pad(value.getDate())}.md`;
}
