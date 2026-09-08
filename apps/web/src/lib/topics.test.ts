import { describe, expect, it } from 'vitest';

import { collapseTopicIssues, fillTrendDays, topicLookupKeys } from './topics';

describe('topicLookupKeys', () => {
  it('keeps plain slug as-is', () => {
    expect(topicLookupKeys('rag-system')).toEqual(['rag-system']);
  });

  it('adds decoded form for URL-encoded Chinese slug', () => {
    const encoded = encodeURIComponent('RAG 系统的上下文');
    expect(topicLookupKeys(encoded)).toEqual([encoded, 'RAG 系统的上下文']);
  });

  it('keeps malformed percent sequences without throwing', () => {
    expect(topicLookupKeys('%E4%B8%AD%')).toEqual(['%E4%B8%AD%']);
  });
});

describe('fillTrendDays', () => {
  it('pads missing days with zero counts', () => {
    const since = new Date('2026-08-25T12:00:00Z');
    const rows = [
      { date: '2026-08-26', count: 2 },
      { date: '2026-08-28', count: 5 },
    ];
    const series = fillTrendDays(rows, since, 4);
    expect(series.map((p) => p.date)).toEqual([
      '2026-08-25',
      '2026-08-26',
      '2026-08-27',
      '2026-08-28',
    ]);
    expect(series.map((p) => p.count)).toEqual([0, 2, 0, 5]);
  });

  it('accepts Date objects and bigint counts from Prisma raw query', () => {
    const since = new Date('2026-08-25T00:00:00Z');
    const rows = [
      { date: new Date('2026-08-25T03:00:00Z'), count: BigInt(3) },
      { date: new Date('2026-08-26T18:00:00Z'), count: BigInt(7) },
    ];
    const series = fillTrendDays(rows, since, 2);
    expect(series).toEqual([
      { date: '2026-08-25', count: 3 },
      { date: '2026-08-26', count: 7 },
    ]);
  });
});

describe('collapseTopicIssues', () => {
  it('collapses repeated single-content issues across event/problem types', () => {
    const issues = [
      {
        id: 'event-1',
        kind: 'event',
        title: 'NavMCP 框架发布',
        candidateIds: ['summary-1'],
        importanceScore: 0.5,
        lastSeenAt: '2026-09-01',
      },
      {
        id: 'event-2',
        kind: 'event',
        title: 'NavMCP 框架提出以实现长时程导航',
        candidateIds: ['summary-1'],
        importanceScore: 0.4,
        lastSeenAt: '2026-09-01',
      },
      {
        id: 'problem-1',
        kind: 'problem',
        title: '基础模型能力割裂',
        candidateIds: ['summary-1'],
        importanceScore: 0.4,
        lastSeenAt: '2026-09-01',
      },
    ];

    expect(collapseTopicIssues(issues).map((issue) => issue.id)).toEqual(['event-1']);
  });

  it('keeps distinct multi-content issues with the same kind', () => {
    const issues = [
      {
        id: 'issue-1',
        kind: 'event',
        title: '同一事件',
        candidateIds: ['summary-1', 'summary-2'],
        importanceScore: 0.5,
        lastSeenAt: '2026-09-01',
      },
      {
        id: 'issue-2',
        kind: 'event',
        title: '另一个事件',
        candidateIds: ['summary-3', 'summary-4'],
        importanceScore: 0.4,
        lastSeenAt: '2026-09-01',
      },
    ];

    expect(collapseTopicIssues(issues).map((issue) => issue.id)).toEqual(['issue-1', 'issue-2']);
  });

  it('collapses exact duplicate multi-content sets', () => {
    const issues = [
      {
        id: 'issue-1',
        kind: 'event',
        title: '一组内容的事件',
        candidateIds: ['summary-2', 'summary-1'],
        importanceScore: 0.5,
        lastSeenAt: '2026-09-01',
      },
      {
        id: 'issue-2',
        kind: 'problem',
        title: '同一组内容的问题',
        candidateIds: ['summary-1', 'summary-2'],
        importanceScore: 0.4,
        lastSeenAt: '2026-09-01',
      },
    ];

    expect(collapseTopicIssues(issues).map((issue) => issue.id)).toEqual(['issue-1']);
  });

  it('collapses high-overlap issues when their generated claims share concepts', () => {
    const issues = [
      {
        id: 'benchmark-problem',
        kind: 'problem',
        title: '纯文本 Agent 排行榜与评测基准失真',
        proposition: '文本排行榜和单一答案评测无法反映真实运行表现。',
        candidateIds: ['summary-1', 'summary-2', 'summary-3', 'summary-4'],
        importanceScore: 0.9,
        firstSeenAt: '2026-08-25',
        lastSeenAt: '2026-08-27',
      },
      {
        id: 'benchmark-event',
        kind: 'event',
        title: '面向 AI Agent 的多领域评测基准集中涌现',
        proposition: '多领域评测基准近期集中发布，揭示智能体在长程任务上的差距。',
        candidateIds: ['summary-1', 'summary-2', 'summary-3', 'summary-5'],
        importanceScore: 0.7,
        firstSeenAt: '2026-08-26',
        lastSeenAt: '2026-08-31',
      },
    ];

    expect(collapseTopicIssues(issues)).toEqual([
      expect.objectContaining({
        id: 'benchmark-problem',
        candidateIds: ['summary-1', 'summary-2', 'summary-3', 'summary-4', 'summary-5'],
        firstSeenAt: '2026-08-25',
        lastSeenAt: '2026-08-31',
      }),
    ]);
  });

  it('keeps high-overlap issues when their claims describe different concepts', () => {
    const issues = [
      {
        id: 'benchmark',
        kind: 'problem',
        title: '评测基准无法反映智能体真实表现',
        proposition: '基准结果与真实运行表现存在系统性偏差。',
        candidateIds: ['summary-1', 'summary-2', 'summary-3', 'summary-4'],
        importanceScore: 0.8,
        lastSeenAt: '2026-08-27',
      },
      {
        id: 'security',
        kind: 'problem',
        title: '安全沙箱存在失控风险',
        proposition: '工具调用权限过大时可能导致数据外泄与任意命令执行。',
        candidateIds: ['summary-1', 'summary-2', 'summary-3', 'summary-5'],
        importanceScore: 0.7,
        lastSeenAt: '2026-08-27',
      },
    ];

    expect(collapseTopicIssues(issues).map((issue) => issue.id)).toEqual([
      'benchmark',
      'security',
    ]);
  });

  it('collapses two-of-three evidence rewrites with the same claim', () => {
    const issues = [
      {
        id: 'self-improvement-1',
        kind: 'event',
        title: '自改进型智能体框架密集涌现',
        proposition: '多项研究发布具备自我迭代能力的智能体框架。',
        candidateIds: ['summary-1', 'summary-2', 'summary-3'],
        importanceScore: 0.8,
        lastSeenAt: '2026-08-31',
      },
      {
        id: 'self-improvement-2',
        kind: 'event',
        title: '自改进/递归智能体研究密集涌现',
        proposition: '近期出现多篇关于自改进智能体的研究。',
        candidateIds: ['summary-2', 'summary-3', 'summary-4'],
        importanceScore: 0.7,
        lastSeenAt: '2026-08-31',
      },
    ];

    expect(collapseTopicIssues(issues)).toHaveLength(1);
  });
});
