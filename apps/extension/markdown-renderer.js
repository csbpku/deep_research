const BLOCK_PATTERNS = {
  heading: /^\s*(#{1,6})\s+(.+?)\s*$/u,
  unordered: /^\s*\\?[-+*]\s+(.+?)\s*$/u,
  ordered: /^\s*(\d+)[.)）]\s*(.+?)\s*$/u,
  orderedListItem: /^\s*(\d+)[.)]\s+(.+?)\s*$/u,
  quote: /^\s*>\s?(.*?)\s*$/u,
  fence: /^\s*```(?:[\w-]+)?\s*$/u,
};

const TABLE_DIVIDER = /^\s*\|?\s*:?-{3,}:?\s*(?:\|\s*:?-{3,}:?\s*)+\|?\s*$/u;
const NUMBERED_SUMMARY_HEADINGS = [
  '文章解决的问题和核心结论',
  '关键机制或架构',
  '重要取舍、适用边界和失败条件',
  '值得继续核对的原文证据',
];
const THEMATIC_BREAK = /^\s*(?:(?:\*\s*){3,}|(?:-\s*){3,}|(?:_\s*){3,})$/u;

function isBlockStart(line) {
  return BLOCK_PATTERNS.heading.test(line)
    || BLOCK_PATTERNS.unordered.test(line)
    || BLOCK_PATTERNS.ordered.test(line)
    || BLOCK_PATTERNS.quote.test(line)
    || BLOCK_PATTERNS.fence.test(line);
}

function splitTableRow(line) {
  return line.trim().replace(/^\||\|$/gu, '').split(/(?<!\\)\|/u).map((cell) => cell.trim().replace(/\\\|/gu, '|'));
}

function orderedListEnd(lines, start) {
  let index = start;
  let count = 0;
  while (index < lines.length) {
    if (BLOCK_PATTERNS.orderedListItem.test(lines[index])) {
      count += 1;
      index += 1;
      continue;
    }
    if (!lines[index].trim() && BLOCK_PATTERNS.orderedListItem.test(lines[index + 1] || '')) {
      index += 1;
      continue;
    }
    break;
  }
  return count >= 2 ? index : start;
}

function pushParagraph(blocks, lines) {
  if (!lines.length) return;
  const content = lines.join('\n').trim();
  if (content) blocks.push({ type: 'paragraph', content });
  lines.length = 0;
}

function isNumberedSection(line) {
  const match = line.match(/^\s*(\d+)[)）]\s*(.+?)\s*$/u);
  if (!match) return null;
  const text = match[2].trim();
  const knownHeading = NUMBERED_SUMMARY_HEADINGS.find((heading) => text.startsWith(`${heading} `));
  if (knownHeading) {
    return { number: match[1], title: knownHeading, body: text.slice(knownHeading.length).trim() };
  }
  return text.length <= 96 ? { number: match[1], title: text, body: '' } : null;
}

export function parseMarkdownBlocks(value) {
  const lines = String(value ?? '').replace(/\r\n?/gu, '\n').split('\n');
  const blocks = [];
  const paragraph = [];
  let index = 0;

  while (index < lines.length) {
    const line = lines[index];
    if (!line.trim()) {
      pushParagraph(blocks, paragraph);
      index += 1;
      continue;
    }

    if (THEMATIC_BREAK.test(line)) {
      pushParagraph(blocks, paragraph);
      blocks.push({ type: 'thematic-break' });
      index += 1;
      continue;
    }

    if (index + 1 < lines.length && line.includes('|') && TABLE_DIVIDER.test(lines[index + 1])) {
      pushParagraph(blocks, paragraph);
      const header = splitTableRow(line);
      const rows = [];
      index += 2;
      while (index < lines.length && lines[index].includes('|') && lines[index].trim()) {
        rows.push(splitTableRow(lines[index]));
        index += 1;
      }
      blocks.push({ type: 'table', header, rows });
      continue;
    }

    if (BLOCK_PATTERNS.fence.test(line)) {
      pushParagraph(blocks, paragraph);
      const codeLines = [];
      index += 1;
      while (index < lines.length && !BLOCK_PATTERNS.fence.test(lines[index])) {
        codeLines.push(lines[index]);
        index += 1;
      }
      if (index < lines.length) index += 1;
      blocks.push({ type: 'code', content: codeLines.join('\n') });
      continue;
    }

    const heading = line.match(BLOCK_PATTERNS.heading);
    if (heading) {
      pushParagraph(blocks, paragraph);
      blocks.push({ type: 'heading', level: heading[1].length, content: heading[2] });
      index += 1;
      continue;
    }

    const numberedSection = isNumberedSection(line);
    const listEnd = orderedListEnd(lines, index);
    if (listEnd > index) {
      pushParagraph(blocks, paragraph);
      const items = lines.slice(index, listEnd)
        .map((item) => item.match(BLOCK_PATTERNS.orderedListItem)?.[2])
        .filter(Boolean);
      blocks.push({ type: 'ordered-list', items });
      index = listEnd;
      continue;
    }
    if (numberedSection) {
      pushParagraph(blocks, paragraph);
      blocks.push({ type: 'numbered-heading', number: numberedSection.number, content: numberedSection.title });
      if (numberedSection.body) blocks.push({ type: 'paragraph', content: numberedSection.body });
      index += 1;
      continue;
    }

    const unordered = line.match(BLOCK_PATTERNS.unordered);
    if (unordered) {
      pushParagraph(blocks, paragraph);
      const items = [];
      while (index < lines.length) {
        const item = lines[index].match(BLOCK_PATTERNS.unordered);
        if (!item) break;
        items.push(item[1]);
        index += 1;
        while (index < lines.length && lines[index].trim() && !isBlockStart(lines[index])) {
          items[items.length - 1] += `\n${lines[index].trim()}`;
          index += 1;
        }
        while (index < lines.length && !lines[index].trim()) {
          const next = lines[index + 1];
          if (!next || !BLOCK_PATTERNS.unordered.test(next)) break;
          index += 1;
        }
      }
      blocks.push({ type: 'unordered-list', items });
      continue;
    }

    const quote = line.match(BLOCK_PATTERNS.quote);
    if (quote) {
      pushParagraph(blocks, paragraph);
      const quoteLines = [];
      while (index < lines.length) {
        const current = lines[index].match(BLOCK_PATTERNS.quote);
        if (!current) break;
        quoteLines.push(current[1]);
        index += 1;
      }
      blocks.push({ type: 'quote', content: quoteLines.join('\n') });
      continue;
    }

    paragraph.push(line);
    index += 1;
  }

  pushParagraph(blocks, paragraph);
  return blocks;
}

function appendInline(parent, value) {
  const source = String(value ?? '');
  const pattern = /(`[^`\n]+`|\*\*[^*\n]+\*\*|__[^_\n]+__|~~[^~\n]+~~|\[([^\]\n]+)\]\((https?:\/\/[^)\s]+)\)|\[\d+\]|\*[^*\n]+\*|_[^_\n]+_)/gu;
  let cursor = 0;
  let match;

  while ((match = pattern.exec(source))) {
    if (match.index > cursor) parent.appendChild(document.createTextNode(source.slice(cursor, match.index)));
    const token = match[0];
    if (token.startsWith('`')) {
      const code = document.createElement('code');
      code.textContent = token.slice(1, -1);
      parent.appendChild(code);
    } else if (/^\[\d+\]$/u.test(token)) {
      const reference = document.createElement('a');
      reference.href = `#reader-evidence-${token.slice(1, -1)}`;
      reference.dataset.readerCitation = token.slice(1, -1);
      reference.className = 'reader-citation-ref';
      reference.textContent = token;
      parent.appendChild(reference);
    } else if (token.startsWith('[')) {
      const link = document.createElement('a');
      link.href = match[3];
      link.target = '_blank';
      link.rel = 'noreferrer noopener';
      link.textContent = match[2];
      parent.appendChild(link);
    } else {
      const isStrong = token.startsWith('**') || token.startsWith('__');
      const isStrike = token.startsWith('~~');
      const node = document.createElement(isStrong ? 'strong' : isStrike ? 'del' : 'em');
      const trim = isStrong || isStrike ? 2 : 1;
      node.textContent = token.slice(trim, -trim);
      parent.appendChild(node);
    }
    cursor = match.index + token.length;
  }

  if (cursor < source.length) parent.appendChild(document.createTextNode(source.slice(cursor)));
}

function appendRichText(parent, value) {
  const lines = String(value ?? '').split('\n');
  lines.forEach((line, index) => {
    if (index) parent.appendChild(document.createElement('br'));
    appendInline(parent, line);
  });
}

export function renderMarkdown(container, value) {
  if (!container) return;
  container.textContent = '';
  parseMarkdownBlocks(value).forEach((block) => {
    let node;
    if (block.type === 'heading') {
      node = document.createElement(`h${Math.min(6, block.level + 2)}`);
      appendRichText(node, block.content);
      node.className = `reader-markdown-heading level-${block.level}`;
    } else if (block.type === 'numbered-heading') {
      node = document.createElement('h3');
      node.className = 'reader-markdown-numbered-heading';
      const number = document.createElement('span');
      number.className = 'reader-markdown-number';
      number.textContent = block.number;
      node.append(number);
      appendRichText(node, block.content);
    } else if (block.type === 'unordered-list') {
      node = document.createElement('ul');
      node.className = 'reader-markdown-list';
      block.items.forEach((item) => {
        const listItem = document.createElement('li');
        appendRichText(listItem, item);
        node.appendChild(listItem);
      });
    } else if (block.type === 'ordered-list') {
      node = document.createElement('ol');
      node.className = 'reader-markdown-list reader-markdown-ordered-list';
      block.items.forEach((item) => {
        const listItem = document.createElement('li');
        appendRichText(listItem, item);
        node.appendChild(listItem);
      });
    } else if (block.type === 'table') {
      node = document.createElement('div');
      node.className = 'reader-markdown-table-wrap';
      const table = document.createElement('table');
      table.className = 'reader-markdown-table';
      const head = document.createElement('thead');
      const headRow = document.createElement('tr');
      block.header.forEach((cell) => {
        const th = document.createElement('th');
        appendRichText(th, cell);
        headRow.appendChild(th);
      });
      head.appendChild(headRow);
      const body = document.createElement('tbody');
      block.rows.forEach((row) => {
        const tr = document.createElement('tr');
        block.header.forEach((_, index) => {
          const td = document.createElement('td');
          appendRichText(td, row[index] || '');
          tr.appendChild(td);
        });
        body.appendChild(tr);
      });
      table.append(head, body);
      node.appendChild(table);
    } else if (block.type === 'quote') {
      node = document.createElement('blockquote');
      node.className = 'reader-markdown-quote';
      appendRichText(node, block.content);
    } else if (block.type === 'code') {
      node = document.createElement('pre');
      node.className = 'reader-markdown-code';
      const code = document.createElement('code');
      code.textContent = block.content;
      node.appendChild(code);
    } else if (block.type === 'thematic-break') {
      node = document.createElement('hr');
      node.className = 'reader-markdown-rule';
    } else {
      node = document.createElement('p');
      node.className = 'reader-markdown-paragraph';
      appendRichText(node, block.content);
    }
    container.appendChild(node);
  });
}
