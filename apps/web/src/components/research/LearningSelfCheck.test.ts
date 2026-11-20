import { describe, expect, it } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { LearningSelfCheck } from './LearningSelfCheck';

const items = [
  { question: '问题一？', answer: '答案一。', hasAnswer: true },
  { question: '问题二？', answer: '答案二。', hasAnswer: true },
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

  it('shows an unanswered question as a stated gap', () => {
    const html = render(createElement(LearningSelfCheck, {
      items: [{ question: '问题三？', answer: '', hasAnswer: false }],
    }));
    expect(html).toContain('问题三？');
    expect(html).toContain('本题缺少答案要点');
    expect(html).not.toContain('你的把握是');
  });

  it('renders nothing without items', () => {
    expect(render(createElement(LearningSelfCheck, { items: [] }))).toBe('');
  });
});
