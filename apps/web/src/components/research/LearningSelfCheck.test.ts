import { describe, expect, it } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { LearningSelfCheck } from './LearningSelfCheck';

describe('LearningSelfCheck', () => {
  it('hides answers until revealed', () => {
    const html = renderToStaticMarkup(
      createElement(LearningSelfCheck, { items: [{ question: '问题？', answer: '答案。' }] }),
    );
    expect(html).toContain('问题？');
    expect(html).not.toContain('答案。');
    expect(html).toContain('你的把握是');
    expect(html).toContain('不确定');
  });
});
