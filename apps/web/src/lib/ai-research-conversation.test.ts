import { describe, expect, it } from 'vitest';

import {
  advanceResearchConversation,
  isResearchQuestionSpecific,
  isStartResearchIntent,
} from './ai-research-conversation';

describe('AI research conversation flow', () => {
  it('asks a targeted follow-up when the question is ambiguous', () => {
    const turn = advanceResearchConversation(
      { topic: '', context: '', phase: 'understand' },
      '帮我调研一下',
    );

    expect(turn.next.phase).toBe('understand');
    expect(turn.canStart).toBe(false);
    expect(turn.reply).toContain('具体的调研对象');
  });

  it('asks for decision context only after a specific question', () => {
    const turn = advanceResearchConversation(
      { topic: '', context: '', phase: 'understand' },
      '我们是否应从 Elasticsearch 迁移到 OpenSearch？',
    );

    expect(turn.next.topic).toContain('OpenSearch');
    expect(turn.next.phase).toBe('refine');
    expect(turn.reply).toContain('什么决策');
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
    expect(isResearchQuestionSpecific('GraphRAG')).toBe(false);
  });
});
