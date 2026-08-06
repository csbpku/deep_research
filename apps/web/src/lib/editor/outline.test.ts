import { describe, expect, it } from 'vitest';
import { activeOutlineItem, parseOutline } from './outline';

describe('research editor outline', () => {
  it('parses only H1-H3 headings and keeps source offsets', () => {
    const markdown = 'intro\n\n# Overview\n\n#### ignored\n\n## Evidence\n\n### Limits';
    const items = parseOutline(markdown);
    expect(items.map(({ level, text }) => ({ level, text }))).toEqual([
      { level: 1, text: 'Overview' },
      { level: 2, text: 'Evidence' },
      { level: 3, text: 'Limits' },
    ]);
    expect(markdown.slice(items[1].offset, items[1].offset + 11)).toBe('## Evidence');
  });

  it('returns the current section for a caret offset', () => {
    const items = parseOutline('# One\ntext\n## Two\nmore');
    expect(activeOutlineItem(items, 0)?.text).toBe('One');
    expect(activeOutlineItem(items, 14)?.text).toBe('Two');
    expect(activeOutlineItem(items, 1)?.id).toBe(items[0].id);
    expect(activeOutlineItem([], 10)).toBeNull();
  });
});
