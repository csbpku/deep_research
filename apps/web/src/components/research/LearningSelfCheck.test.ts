import { describe, expect, it } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { LearningSelfCheck } from './LearningSelfCheck';

const items = [
  { question: '问题一？', answer: '答案一。' },
  { question: '问题二？', answer: '答案二。' },
];

describe('LearningSelfCheck', () => {
  it('hides answers until the reader rates the question', () => {
    const html = renderToStaticMarkup(createElement(LearningSelfCheck, { items }));
    expect(html).toContain('问题一？');
    expect(html).not.toContain('答案一。');
    expect(html).toContain('你的把握是');
    expect(html).toContain('不确定');
  });

  it('renders nothing without items', () => {
    expect(renderToStaticMarkup(createElement(LearningSelfCheck, { items: [] }))).toBe('');
  });
});
