export interface OutlineItem {
  id: string;
  level: 1 | 2 | 3;
  text: string;
  offset: number;
}

/** Parse Markdown H1–H3 headings into stable editor navigation targets. */
export function parseOutline(markdown: string): OutlineItem[] {
  const re = /^(#{1,3})\s+(.+)$/gm;
  const items: OutlineItem[] = [];
  let match: RegExpExecArray | null;
  let index = 0;
  while ((match = re.exec(markdown)) !== null) {
    const text = match[2].trim();
    items.push({
      id: `h-${index++}-${text.slice(0, 16).replace(/\s+/gu, '-')}`,
      level: match[1].length as 1 | 2 | 3,
      text,
      offset: match.index,
    });
  }
  return items;
}

export function activeOutlineItem(items: OutlineItem[], offset: number): OutlineItem | null {
  return items.reduce<OutlineItem | null>(
    (active, item) => (item.offset <= offset ? item : active),
    null,
  );
}
