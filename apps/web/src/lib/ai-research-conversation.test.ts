import { describe, expect, it } from 'vitest';

import {
  advanceResearchConversation,
  isResearchQuestionSpecific,
  isStartResearchIntent,
} from './ai-research-conversation';

describe('AI research conversation flow', () => {
  it('preserves long questions and new requirements past the former limits', () => {
    const question = '学习 Grok Bot。\n' + '保留原理和实践要求。'.repeat(300);
    const first = advanceResearchConversation({ topic: '', context: '', phase: 'understand' }, question);
    expect(first.next.topic).toBe(question);
    const context = '已有背景。'.repeat(500);
    const addition = '务必保留本次新增的部署和安全要求。';
    const next = advanceResearchConversation({ ...first.next, context }, addition);
    expect(next.next.context).toBe(`${context}\n${addition}`);
  });

  it('explicitly rejects excess context instead of claiming it was included', () => {
    const state = { topic: 'Grok Bot', context: 'x'.repeat(19990), phase: 'ready' as const };
    const next = advanceResearchConversation(state, 'additional requirements');
    expect(next.next).toBe(state);
    expect(next.reply).toContain('尚未纳入');
    expect(next.reply).not.toContain('已补充');
  });

  it('asks a targeted follow-up when the question is ambiguous', () => {
    const turn = advanceResearchConversation(
      { topic: '', context: '', phase: 'understand' },
      '帮我调研一下',
    );

    expect(turn.next.phase).toBe('understand');
    expect(turn.canStart).toBe(false);
    expect(turn.reply).toContain('具体的调研对象');
  });

  it('does not require decision context after a specific question', () => {
    const turn = advanceResearchConversation(
      { topic: '', context: '', phase: 'understand' },
      '我们是否应从 Elasticsearch 迁移到 OpenSearch？',
    );

    expect(turn.next.topic).toContain('OpenSearch');
    expect(turn.next.phase).toBe('ready');
    expect(turn.reply).toContain('直接开始');
  });

  it('allows people to skip optional background and continue', () => {
    const turn = advanceResearchConversation(
      { topic: '评估 GraphRAG 的生产可行性', context: '', phase: 'refine' },
      '跳过',
    );

    expect(turn.next.phase).toBe('ready');
    expect(turn.canStart).toBe(true);
    expect(turn.reply).toContain('直接开始');
  });

  it('recognizes a natural start request', () => {
    expect(isStartResearchIntent('直接开始')).toBe(true);
    expect(isResearchQuestionSpecific('GraphRAG')).toBe(true);
  });

  it.each(['我想学习一下grok bot', '学习一下 PostgreSQL', 'Grok Bot', 'AI', 'Go', '了解向量数据库'])(
    'accepts a named learning subject: %s',
    (input) => {
      const turn = advanceResearchConversation({ topic: '', context: '', phase: 'understand' }, input);
      expect(turn.canStart).toBe(true);
      expect(turn.next.topic).toBe(input);
      expect(turn.next.phase).toBe('ready');
      expect(turn.reply).not.toContain('预算');
      expect(turn.reply).not.toContain('什么决策');
    },
  );

  it.each(['帮我调研一下', '帮我调研一下这个', '帮我调研一下这个问题', '我想学习一下', '请研究', '这个', '？', '跳过', '你好', '谢谢', '好的', '还没想好', 'hello'])(
    'still asks for an object when one is missing: %s',
    (input) => {
      expect(isResearchQuestionSpecific(input)).toBe(false);
    },
  );
});
