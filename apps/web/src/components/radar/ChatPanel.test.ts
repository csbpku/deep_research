import { createElement, createRef } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

import { ChatPanel } from './ChatPanel';

function render(
  messages: Parameters<typeof ChatPanel>[0]['messages'],
  overrides: Partial<Parameters<typeof ChatPanel>[0]> = {},
) {
  return renderToStaticMarkup(createElement(ChatPanel, {
    messages,
    loading: false,
    sending: false,
    slowGeneration: false,
    thinkingStep: 0,
    err: null,
    input: '',
    onInputChange: vi.fn(),
    onSubmit: vi.fn(),
    onRetryLoad: vi.fn(),
    messagesRef: createRef<HTMLDivElement>(),
    textareaRef: createRef<HTMLTextAreaElement>(),
    ...overrides,
  }));
}

describe('ChatPanel', () => {
  it('shows suggested questions only for an empty conversation', () => {
    expect(render([])).toContain('推荐问题');
    expect(render([{
      id: 'm1',
      role: 'user',
      content: '解释这一段',
      createdAt: '2026-08-21T00:00:00.000Z',
    }])).not.toContain('推荐问题');
  });

  it('labels the AI send button distinctly from the comment composer', () => {
    expect(render([])).toContain('aria-label="发送 AI 问题"');
  });

  it('shows a slow-generation hint and a stop control while waiting', () => {
    const html = render([{
      id: 'streaming',
      role: 'assistant',
      content: '',
      createdAt: '2026-08-21T00:00:00.000Z',
    }], {
      sending: true,
      slowGeneration: true,
      onStop: vi.fn(),
    });
    expect(html).toContain('生成较慢，正在继续');
    expect(html).toContain('aria-label="停止生成"');
  });

  it('offers stop while partial streaming content is visible', () => {
    const html = render([{
      id: 'm1',
      role: 'assistant',
      content: '部分回答',
      createdAt: '2026-08-21T00:00:00.000Z',
    }], {
      sending: true,
      onStop: vi.fn(),
    });
    expect(html).toContain('aria-label="停止生成"');
    expect(html).toContain('部分回答');
  });
});
