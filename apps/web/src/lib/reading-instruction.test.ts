import { describe, expect, it } from 'vitest';
import { readingInstruction } from './reading-instruction';

describe('reading instruction context budget', () => {
  it('keeps the current question and recent source URLs instead of the oldest chat', () => {
    const instruction = readingInstruction({ action: 'ask', prompt: 'What does W1 refer to?', history: [{ role: 'assistant', content: 'old context '.repeat(1000) }, { role: 'assistant', content: 'Previous source [W1] https://react.dev/learn' }] });
    expect(instruction).toContain('What does W1 refer to?');
    expect(instruction).toContain('https://react.dev/learn');
    expect(instruction!.length).toBeLessThanOrEqual(2000);
  });
  it('reserves the full budget for a long current question and leaves translations unchanged', () => {
    expect(readingInstruction({ action: 'ask', prompt: 'Q'.repeat(4000), history: [{ role: 'assistant', content: 'history' }] })?.length).toBe(2000);
    expect(readingInstruction({ action: 'translate', prompt: 'Translate into English.', history: [] })).toBe('Translate into English.');
  });
});
