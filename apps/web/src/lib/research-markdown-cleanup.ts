const HTML_ENTITIES: Record<string, string> = {
  amp: '&',
  apos: "'",
  copy: '©',
  hellip: '…',
  laquo: '«',
  ldquo: '“',
  lsquo: '‘',
  mdash: '—',
  middot: '·',
  nbsp: ' ',
  ndash: '–',
  quot: '"',
  raquo: '»',
  rdquo: '”',
  rsquo: '’',
  reg: '®',
  trade: '™',
  lt: '<',
  gt: '>',
};

function decodeHtmlEntities(content: string): string {
  return content.replace(
    /&((?:#?x[\da-f]+|#?\d+)|[a-z][\da-z]+);/giu,
    (match, token: string) => {
      const normalized = token.toLowerCase();
      const numericToken = normalized.replace(/^#/u, '');
      if (numericToken.startsWith('x')) {
        const codePoint = Number.parseInt(numericToken.slice(1), 16);
        return codePoint < 0 || codePoint > 0x10ffff
          ? match
          : String.fromCodePoint(codePoint);
      }
      if (/^\d+$/u.test(numericToken)) {
        const codePoint = Number.parseInt(numericToken, 10);
        return codePoint < 0 || codePoint > 0x10ffff
          ? match
          : String.fromCodePoint(codePoint);
      }
      return HTML_ENTITIES[normalized] ?? match;
    },
  );
}

/** Remove browser-wrapper reference lines accidentally persisted in reports. */
export function cleanResearchMarkdown(content: string): string {
  let inReferences = false;
  let referenceNumber = 1;
  const lines = content.split('\n');
  const cleaned: string[] = [];

  for (const line of lines) {
    if (/^\s{0,3}#{1,6}\s+参考文献\s*$/u.test(line)) {
      inReferences = true;
      referenceNumber = 1;
      cleaned.push(line);
      continue;
    }
    if (inReferences && /^\s{0,3}#{1,6}\s+/u.test(line)) inReferences = false;
    if (/^\s*(?:\d+[.)]|[-*+])\s+.*\/goto\?url=/iu.test(line)) continue;
    if (inReferences && /^\s*\d+[.)]\s+/u.test(line)) {
      cleaned.push(line.replace(/^(\s*)\d+[.)](\s+)/u, `$1${referenceNumber++}.$2`));
      continue;
    }
    cleaned.push(line);
  }

  return decodeHtmlEntities(cleaned.join('\n'))
    .replace(/\n{3,}/gu, '\n\n');
}

/** Clean plain text fields without collapsing meaningful line breaks. */
export function cleanResearchText(content: string): string {
  return decodeHtmlEntities(content).replace(/\u00a0/gu, ' ').trim();
}

/** 清理标题、来源标题等非 Markdown 文本中的 HTML 空格实体。 */
export function cleanResearchLabel(content: string): string {
  return cleanResearchText(content).replace(/\s+/gu, ' ').trim();
}
