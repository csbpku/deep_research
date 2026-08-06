import { describe, expect, it } from 'vitest';
import { commandQuery, matchingCommands } from './markdown-commands';

describe('markdown editor commands', () => {
  it('only activates slash commands at the current line start', () => {
    expect(commandQuery('/tab', 4)).toBe('tab');
    expect(commandQuery('text /tab', 9)).toBeNull();
    expect(commandQuery('text\n  /hea', 11)).toBe('hea');
  });

  it('matches command keys and Chinese labels', () => {
    expect(matchingCommands('tab').map((item) => item.key)).toContain('table');
    expect(matchingCommands('任务').map((item) => item.key)).toEqual(['todo']);
  });
});
