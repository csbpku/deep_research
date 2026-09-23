const BLOCK_PATTERNS = {
  heading: /^\s*(#{1,3})\s+(.+?)\s*$/u,
  unordered: /^\s*\\?[-+*]\s+(.+?)\s*$/u,
  ordered: /^\s*(\d+)[.)）]\s*(.+?)\s*$/u,
  quote: /^\s*>\s?(.*?)\s*$/u,
  fence: /^\s*```(?:[\w-]+)?\s*$/u,
};

function isBlockStart(line) {
  return BLOCK_PATTERNS.heading.test(line)
    || BLOCK_PATTERNS.unordered.test(line)
    || BLOCK_PATTERNS.ordered.test(line)
    || BLOCK_PATTERNS.quote.test(line)
    || BLOCK_PATTERNS.fence.test(line);
}

function pushParagraph(blocks, lines) {
  if (!lines.length) return;
  const content = lines.join('\n').trim();
  if (content) blocks.push({ type: 'paragraph', content });
  lines.length = 0;
}

function isNumberedSection(line) {
  const match = line.match(BLOCK_PATTERNS.ordered);
  if (!match) return null;
  const title = match[2].trim();
  return title.length <= 96 ? { number: match[1], title } : null;
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
    if (numberedSection) {
      pushParagraph(blocks, paragraph);
      blocks.push({ type: 'numbered-heading', number: numberedSection.number, content: numberedSection.title });
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
  const pattern = /(`[^`\n]+`|\*\*[^*\n]+\*\*|__[^_\n]+__|\[([^\]\n]+)\]\((https?:\/\/[^)\s]+)\))/gu;
  let cursor = 0;
  let match;

  while ((match = pattern.exec(source))) {
    if (match.index > cursor) parent.appendChild(document.createTextNode(source.slice(cursor, match.index)));
    const token = match[0];
    if (token.startsWith('`')) {
      const code = document.createElement('code');
      code.textContent = token.slice(1, -1);
      parent.appendChild(code);
    } else if (token.startsWith('[')) {
      const link = document.createElement('a');
      link.href = match[3];
      link.target = '_blank';
      link.rel = 'noreferrer noopener';
      link.textContent = match[2];
      parent.appendChild(link);
    } else {
      const strong = document.createElement('strong');
      strong.textContent = token.slice(2, -2);
      parent.appendChild(strong);
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
      node = document.createElement(block.level === 1 ? 'h3' : 'h4');
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
    } else {
      node = document.createElement('p');
      node.className = 'reader-markdown-paragraph';
      appendRichText(node, block.content);
    }
    container.appendChild(node);
  });
}
