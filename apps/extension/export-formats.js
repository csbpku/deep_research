/**
 * Additional export writers for the local Reader library: Obsidian vault files,
 * a Notion-friendly paste document and a single-record clipboard snippet.
 *
 * reader-export.js owns the existing Markdown document. These writers live
 * apart because each target needs a different wrapper (YAML frontmatter,
 * callouts, Notion blocks) and because the panel dispatches on a format id
 * instead of growing conditionals inside that module.
 *
 * Every function here is pure: no storage, no clock reads, no mutation of the
 * records passed in, and no throws for null/partial records. The panel can hand
 * these writers a half-loaded store without losing the export button.
 */

import { libraryEntry } from './reader-library.js';

export const EXPORT_FORMATS = Object.freeze(['markdown', 'obsidian', 'notion']);

const UNKNOWN_TYPE_LABEL = '条目';
const UNTITLED_PAGE = '未标注页面';
const EMPTY_COLLECTION_NOTE = '（还没有收藏内容。）';
const EMPTY_RECORD_NOTE = '（没有可复制的条目。）';
const NOTION_TITLE = 'Reader 收藏';
const OBSIDIAN_SOURCE = 'deep-research-reader';
const DEFAULT_FOLDER = 'Reader';
const MAX_FILE_NAME = 80;

/* ------------------------------------------------------------------ *
 * Escaping
 *
 * Saved quotes are copied out of documentation and routinely contain fences,
 * `#` headings, `>` quotes and `---` rules. Emitting them verbatim would
 * change the shape of the exported document, so user text is neutralised
 * before it lands in a heading, paragraph, callout or blockquote. The rules
 * mirror reader-export.js so both writers agree on what "safe text" means.
 * ------------------------------------------------------------------ */

/** Fenced code is the one construct a single backtick cannot escape. */
function escapeInline(value) {
  return String(value ?? '')
    .replace(/\\/gu, '\\\\')
    // Only ambiguous ampersands are rewritten: "R&D" stays readable.
    .replace(/&(?=#?[A-Za-z0-9]+;)/gu, '&amp;')
    .replace(/</gu, '&lt;')
    .replace(/`{3,}/gu, match => match.replace(/`/gu, '\\`'));
}

/**
 * A block-level line can still start a heading, list, blockquote, thematic
 * break or setext underline after inline escaping, so leading markers get a
 * backslash. A one-character `-` line is both a list marker and a setext
 * underline; both are neutralised.
 */
function escapeLine(line) {
  const indent = line.match(/^\s*/u)[0];
  let body = line.slice(indent.length);
  // Setext underlines (`---`, `===`) and thematic breaks (`***`, `_ _ _`) are
  // shape changes even though they look like punctuation. One leading
  // backslash is enough: a line that no longer starts with the marker cannot
  // open the construct, and it keeps the raw file readable.
  if (/^[=-]+$/u.test(body) || /^(?:[*_]\s*){3,}$/u.test(body)) body = `\\${body}`;
  else if (/^#{1,6}(\s|$)/u.test(body) || /^>/u.test(body)) body = `\\${body}`;
  else if (/^[-+*](\s|$)/u.test(body)) body = `\\${body}`;
  else if (/^\d{1,9}[.)](\s|$)/u.test(body)) body = body.replace(/^(\d{1,9})([.)])/u, '$1\\$2');
  // Four spaces of indent would open a code block; clamping keeps note
  // indentation visible without changing the document shape.
  return `${indent.length > 3 ? '   ' : indent}${body}`;
}

/** Render free text as prose: inline escapes, then per-line block markers. */
function text(value) {
  return escapeInline(value)
    .split(/\r?\n/u)
    .map(line => escapeLine(line.replace(/\s+$/u, '')))
    .join('\n');
}

/** Same escaping for one-line slots (headings, labels), newlines flattened. */
function inline(value) {
  return escapeInline(String(value ?? '').replace(/[\r\n]+/gu, ' ').trim());
}

/** Blockquote every line so a quote can never escape the quote it lives in. */
function quoteLines(value) {
  return text(value).split('\n').map(line => (line ? `> ${line}` : '>')).join('\n');
}

/** Obsidian callout: a `> [!type]` header followed by the blockquoted body. */
function callout(type, title, value) {
  const header = `> [!${type}]${title ? ` ${title}` : ''}`;
  return [header, ...quoteLines(value).split('\n')].join('\n');
}

/**
 * YAML double-quoted scalar. Newlines become `\n` and every other control
 * character is hex-escaped, so a title containing a literal `---` line can
 * never terminate the frontmatter block early. Always quoting also keeps
 * values such as "yes", "12" or "#tag" as strings instead of changing type.
 */
function yamlString(value) {
  const body = String(value ?? '')
    .replace(/\r\n?/gu, '\n')
    .replace(/\\/gu, '\\\\')
    .replace(/"/gu, '\\"')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\u2028\u2029]/gu,
      character => `\\u${character.codePointAt(0).toString(16).padStart(4, '0')}`)
    .replace(/\t/gu, '\\t')
    .replace(/\n/gu, '\\n');
  return `"${body}"`;
}

/* ------------------------------------------------------------------ *
 * Records and pages
 * ------------------------------------------------------------------ */

function timestampOf(value) {
  return Date.parse(String(value ?? ''));
}

function itemTime(item) {
  return String(item?.updatedAt || item?.createdAt || '');
}

function hasText(value) {
  return String(value ?? '').trim().length > 0;
}

function hostnameOf(url) {
  try {
    return new URL(String(url)).hostname;
  } catch {
    return '';
  }
}

/** Local wall-clock date: the export is read in the reader's own time zone. */
function localDate(time) {
  if (!Number.isFinite(time)) return '';
  const date = new Date(time);
  if (Number.isNaN(date.getTime())) return '';
  const pad = number => String(number).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

function zhCompare(first, second) {
  return String(first ?? '').localeCompare(String(second ?? ''), 'zh');
}

/** Accept the flat view model and libraryPage()'s `{ kind, record }` entries. */
function normalizeItems(items) {
  return (Array.isArray(items) ? items : []).filter(Boolean).map(libraryEntry);
}

function itemTags(item) {
  return (Array.isArray(item?.tags) ? item.tags : [])
    .filter(tag => typeof tag === 'string' && tag.trim())
    .map(tag => tag.trim());
}

/**
 * Tags are de-duplicated case-insensitively (the panel already does this) and
 * sorted with the same zh collation as the file keys, so two exports of one
 * collection never reorder the frontmatter. Entries are newest-first, so the
 * surviving spelling is the newest one; the choice only has to be stable.
 */
function sortedTags(tags) {
  const seen = new Set();
  const values = [];
  for (const tag of tags) {
    const value = String(tag ?? '').trim();
    if (!value) continue;
    const key = value.normalize('NFKC').toLocaleLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    values.push(value);
  }
  return values.sort(zhCompare);
}

/**
 * Groups are ordered by page title for a stable object key order, then by URL
 * so two untitled pages still have a deterministic order. Entries inside a
 * group are newest first, matching how the panel lists them.
 */
function pageGroups(records) {
  const groups = new Map();
  for (const item of records) {
    const url = String(item?.url || '').trim();
    const group = groups.get(url) || { url, items: [] };
    group.items.push(item);
    groups.set(url, group);
  }
  const result = [...groups.values()];
  for (const group of result) {
    group.items.sort((first, second) => (timestampOf(itemTime(second)) || 0) - (timestampOf(itemTime(first)) || 0)
      || `${first?.kind}:${first?.id}`.localeCompare(`${second?.kind}:${second?.id}`));
    const titled = group.items.find(item => typeof item?.title === 'string' && item.title.trim());
    // Page title falls back to the hostname, which is what the file name uses.
    group.title = titled ? titled.title.trim() : hostnameOf(group.url) || group.url;
    group.site = hostnameOf(group.url)
      || group.items.map(item => (typeof item?.site === 'string' ? item.site.trim() : '')).find(Boolean)
      || '';
  }
  return result.sort((first, second) => zhCompare(first.title, second.title) || zhCompare(first.url, second.url));
}

function entryLabel(item) {
  // Explicit cases instead of an object lookup: a hostile `kind` such as
  // "__proto__" must not resolve to Object.prototype and print as a label.
  if (item?.kind === 'insight') return '摘录';
  if (item?.kind === 'annotation') return '标注';
  return UNKNOWN_TYPE_LABEL;
}

function entryDate(item) {
  return localDate(timestampOf(itemTime(item)));
}

/* ------------------------------------------------------------------ *
 * Obsidian
 * ------------------------------------------------------------------ */

/** Case-insensitive because macOS and Windows treat "Page" and "page" as one name. */
function fileNameRegistry() {
  const used = new Set();
  return base => {
    let candidate = base;
    let suffix = 2;
    while (used.has(candidate.toLowerCase())) candidate = `${base}-${suffix++}`;
    used.add(candidate.toLowerCase());
    return candidate;
  };
}

/**
 * `\ / : * ? " < > |` are rejected by at least one file system, control
 * characters break archives, and leading/trailing dots or spaces are dropped
 * by Explorer/Finder. Whitespace runs become `-`; Chinese is preserved.
 * Truncation counts code points so an emoji title is never cut in half.
 */
function sanitizeFileName(value) {
  const cleaned = String(value ?? '')
    .replace(/[\u0000-\u001f\u007f-\u009f]/gu, ' ')
    .replace(/[\\/:*?"<>|]/gu, '-')
    .replace(/\s+/gu, '-')
    .replace(/-{2,}/gu, '-');
  const trimmed = cleaned.replace(/^[.\-\s]+|[.\-\s]+$/gu, '');
  return [...trimmed].slice(0, MAX_FILE_NAME).join('').replace(/[.\-\s]+$/gu, '');
}

export function safeFileName(title, fallback = 'untitled') {
  return sanitizeFileName(title) || sanitizeFileName(fallback) || 'untitled';
}

/** Obsidian folders may nest with `/`; each segment gets the file-name rules. */
function folderOf(options) {
  const raw = String(options?.folder ?? DEFAULT_FOLDER).replace(/\\/gu, '/');
  const parts = raw.split('/').map(sanitizeFileName).filter(Boolean);
  return parts.length ? parts.join('/') : DEFAULT_FOLDER;
}

function frontmatterFor(group) {
  // A loop rather than Math.min(...times): a page with thousands of records
  // must not hit the argument-count limit.
  let earliest = Infinity;
  let latest = -Infinity;
  for (const item of group.items) {
    const time = timestampOf(itemTime(item));
    if (Number.isNaN(time)) continue;
    if (time < earliest) earliest = time;
    if (time > latest) latest = time;
  }
  const created = Number.isFinite(earliest) ? localDate(earliest) : '';
  const updated = Number.isFinite(latest) ? localDate(latest) : '';
  const tags = sortedTags(group.items.flatMap(itemTags));
  const lines = [
    '---',
    `title: ${yamlString(group.title || UNTITLED_PAGE)}`,
    `url: ${yamlString(group.url)}`,
    `site: ${yamlString(group.site)}`,
  ];
  // Unknown dates are omitted rather than exported as an empty property that
  // Obsidian would show as a broken date.
  if (created) lines.push(`created: ${created}`);
  if (updated) lines.push(`updated: ${updated}`);
  if (tags.length) {
    lines.push('tags:');
    for (const tag of tags) lines.push(`  - ${yamlString(tag)}`);
  } else {
    lines.push('tags: []');
  }
  lines.push(`source: ${OBSIDIAN_SOURCE}`, '---');
  return lines.join('\n');
}

function obsidianSource(url) {
  const value = String(url ?? '').trim();
  if (!value) return '';
  // `<...>` autolinks break on whitespace, angle brackets and backticks; any
  // other value is escaped as plain text.
  return /^https?:\/\/[^\s<>`]+$/iu.test(value) ? `来源：<${value}>` : `来源：${inline(value)}`;
}

function obsidianEntry(item) {
  const date = entryDate(item);
  const blocks = [`## ${date ? `${date} · ` : ''}${entryLabel(item)}`];
  if (hasText(item?.quote)) blocks.push(callout('quote', '', item.quote));
  if (hasText(item?.note)) blocks.push(`**我的笔记**：${text(item.note)}`);
  if (hasText(item?.aiAnswer)) blocks.push(callout('note', 'AI 结论', item.aiAnswer));
  // Per-entry tags are not repeated: the frontmatter aggregates every entry's
  // tags, which is what an Obsidian vault searches on.
  const source = obsidianSource(item?.url);
  if (source) blocks.push(source);
  return blocks;
}

function joinBlocks(blocks) {
  return `${blocks.filter(block => typeof block === 'string' && block.trim()).join('\n\n')
    .replace(/\n{3,}/gu, '\n\n').trimEnd()}\n`;
}

function renderObsidianNote(group) {
  const blocks = [frontmatterFor(group), `# ${inline(group.title) || UNTITLED_PAGE}`];
  for (const item of group.items) blocks.push(...obsidianEntry(item));
  return joinBlocks(blocks);
}

/**
 * One file per page, keyed `folder/<page title>.md`. Keys are inserted in page
 * title order so a UI can use Object.keys() directly for a sorted download
 * list. Same-named pages get `-2`, `-3` … instead of overwriting each other.
 */
export function exportObsidian(items, options = {}) {
  const records = normalizeItems(items);
  if (!records.length) return {};
  const folder = folderOf(options);
  const uniqueName = fileNameRegistry();
  const files = {};
  for (const group of pageGroups(records)) {
    const name = uniqueName(safeFileName(group.title || hostnameOf(group.url)));
    files[`${folder}/${name}.md`] = renderObsidianNote(group);
  }
  return files;
}

/* ------------------------------------------------------------------ *
 * Notion
 * ------------------------------------------------------------------ */

function notionSource(url) {
  const value = String(url ?? '').trim();
  if (!value) return '';
  // Bare URL: Notion turns it into a link/embed on paste, and `<...>` would
  // otherwise be pasted literally.
  return /^https?:\/\/[^\s<>`]+$/iu.test(value) ? `来源：${value}` : `来源：${inline(value)}`;
}

function notionEntry(item) {
  const date = entryDate(item);
  const blocks = [`### ${entryLabel(item)}${date ? ` · ${date}` : ''}`];
  if (hasText(item?.quote)) blocks.push(quoteLines(item.quote));
  if (hasText(item?.note)) blocks.push(`**我的笔记**：${text(item.note)}`);
  if (hasText(item?.aiAnswer)) blocks.push(`**AI 结论**：${text(item.aiAnswer)}`);
  const tags = sortedTags(itemTags(item));
  if (tags.length) blocks.push(`🏷 ${tags.map(inline).join(', ')}`);
  const source = notionSource(item?.url);
  if (source) blocks.push(source);
  return blocks;
}

/**
 * A single paste target: Notion has no frontmatter concept, so the hierarchy
 * (`#` document, `##` page, `###` entry) carries the structure and each block
 * is separated by one blank line, which is what its Markdown paste expects.
 */
export function exportNotion(items, options = {}) {
  const title = inline(options?.title) || NOTION_TITLE;
  const records = normalizeItems(items);
  const blocks = [`# ${title}`];
  if (!records.length) {
    blocks.push(EMPTY_COLLECTION_NOTE);
  } else {
    for (const group of pageGroups(records)) {
      blocks.push(`## ${inline(group.title) || UNTITLED_PAGE}`);
      for (const item of group.items) blocks.push(...notionEntry(item));
    }
  }
  return joinBlocks(blocks);
}

/* ------------------------------------------------------------------ *
 * Single record
 * ------------------------------------------------------------------ */

/** `[label](url)`, with a label that cannot close the link early. */
function linkLabel(value) {
  return inline(value).replace(/[[\]]/gu, match => `\\${match}`);
}

function markdownSource(item) {
  const url = String(item?.url ?? '').trim();
  if (!url) return '';
  if (!/^https?:\/\/[^\s<>`]+$/iu.test(url)) return `来源：${inline(url)}`;
  const label = linkLabel(item?.title || hostnameOf(url) || url);
  // Angle-bracket destinations keep Wikipedia-style `Foo_(bar)` URLs intact.
  const destination = /[()<>]/u.test(url) ? `<${url}>` : url;
  return `来源：[${label}](${destination})`;
}

/**
 * Clipboard text for one saved record: quote, note, AI conclusion, tags and a
 * source link. Missing fields are skipped entirely (no blank paragraphs), and
 * exactly one trailing newline is emitted so repeated copies stay clean.
 */
export function exportSingleRecord(item, options = {}) {
  const record = item && typeof item === 'object' ? libraryEntry(item) : null;
  if (!record || typeof record !== 'object') return `${EMPTY_RECORD_NOTE}\n`;
  const blocks = [];
  if (options?.includeTitle && hasText(record.title)) blocks.push(`# ${inline(record.title)}`);
  if (hasText(record.quote)) blocks.push(quoteLines(record.quote));
  if (hasText(record.note)) blocks.push(`**我的笔记**：${text(record.note)}`);
  if (hasText(record.aiAnswer)) blocks.push(`**AI 结论**：${text(record.aiAnswer)}`);
  const tags = sortedTags(itemTags(record));
  if (tags.length) blocks.push(`**标签**：${tags.map(inline).join('、')}`);
  const source = markdownSource(record);
  if (source) blocks.push(source);
  if (!blocks.length) return `${EMPTY_RECORD_NOTE}\n`;
  return joinBlocks(blocks);
}
