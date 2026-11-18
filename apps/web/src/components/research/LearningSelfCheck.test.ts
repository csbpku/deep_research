import { describe, expect, it } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { LearningSelfCheck } from './LearningSelfCheck';

const items = [
  { question: '问题一？', answer: '答案一。' },
  { question: '问题二？', answer: '答案二。' },
];

function render(node: React.ReactElement) {
  return renderToStaticMarkup(
    createElement(QueryClientProvider, { client: new QueryClient() }, node),
  );
}

describe('LearningSelfCheck', () => {
  it('hides answers until the reader rates the question', () => {
    const html = render(createElement(LearningSelfCheck, { items }));
    expect(html).toContain('问题一？');
    expect(html).not.toContain('答案一。');
    expect(html).toContain('你的把握是');
    expect(html).toContain('不确定');
  });

  it('renders nothing without items', () => {
    expect(render(createElement(LearningSelfCheck, { items: [] }))).toBe('');
  });
});

describe('LearningSelfCheck streak hint', () => {
  it('tells the reader one more correct answer retires the weak mark', () => {
    const html = render(
      createElement(LearningSelfCheck, {
        items: [{ question: 'q1', answer: 'a1' }],
        researchId: 'r1',
        initialStreaks: { q1: 1 },
        initialRatings: { q1: 'unsure' },
      }),
    );
    expect(html).toContain('再答对 1 次就移出待复习');
    expect(html).toContain('data-testid="self-check-streak-hint"');
  });
});
