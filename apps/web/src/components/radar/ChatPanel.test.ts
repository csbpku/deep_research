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

  it('explains a slow session load and offers a reconnect action', () => {
    const html = render([], {
      loading: true,
      slowLoading: true,
      onRetryLoad: vi.fn(),
    });
    expect(html).toContain('连接较慢，仍在准备会话…');
    expect(html).toContain('正文阅读不受影响');
    expect(html).toContain('重新连接');
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

  it('shows one stop control only for the active streaming answer', () => {
    const html = render([
      {
        id: 'history',
        role: 'assistant',
        content: '历史回答',
        createdAt: '2026-08-21T00:00:00.000Z',
      },
      {
        id: 'streaming',
        role: 'assistant',
        content: '正在生成的回答',
        createdAt: '2026-08-21T00:00:00.000Z',
      },
    ], {
      sending: true,
      onStop: vi.fn(),
    });

    expect((html.match(/aria-label="停止生成"/g) ?? []).length).toBe(1);
  });

  it('makes a historical user question without an answer recoverable', () => {
    const html = render([{
      id: 'm1',
      role: 'user',
      content: '核心结论是什么？',
      createdAt: '2026-08-21T00:00:00.000Z',
    }]);

    expect(html).toContain('回答未返回');
    expect(html).toContain('重试回答');
  });

  it('states what source context grounds the conversation', () => {
    const html = render([], {
      contextLabel: '技术文章正文 · Hugging Face Blog',
    });

    expect(html).toContain('讨论上下文');
    expect(html).toContain('技术文章正文 · Hugging Face Blog');
    expect(html).toContain('我会基于技术文章正文 · Hugging Face Blog回答');
  });

  it('uses a source-neutral label for non-GitHub citations by default', () => {
    const html = render([{
      id: 'm1',
      role: 'assistant',
      content: '结论',
      createdAt: '2026-08-21T00:00:00.000Z',
      sources: [{ quote: '原文证据', sourceUrl: 'https://example.com/article' }],
    }]);

    expect(html).toContain('打开来源');
    expect(html).not.toContain('打开 GitHub 来源');
  });

  it('makes an ungrounded answer actionable without inventing a citation', () => {
    const html = render([{
      id: 'm1',
      role: 'assistant',
      content: '这是一条没有可解析引用的回答。',
      createdAt: '2026-08-21T00:00:00.000Z',
      sources: [],
    }]);

    expect(html).toContain('未检测到可回链引用，请按原文复核');
    expect(html).toContain('没有解析出可以回到正文的引用');
  });
});
