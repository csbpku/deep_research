// ADR 0010: /api/ai-research/plan 意图识别 + brief 装配。

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const MOCK_USER = {
  id: '11111111-1111-4111-8111-111111111111',
  email: 'u@x.com',
  name: 'U',
  role: 'member' as const,
};

const mocks = vi.hoisted(() => ({
  requireUser: vi.fn(),
  topicFindMany: vi.fn(),
}));

vi.mock('@/lib/auth/session', () => ({
  requireUser: mocks.requireUser,
  getCurrentUser: vi.fn(async () => MOCK_USER),
}));
vi.mock('@/lib/db', () => ({
  prisma: {
    topic: { findMany: mocks.topicFindMany, findUnique: vi.fn(async () => null) },
    research: { findMany: vi.fn(async () => []) },
  },
}));

import { NextResponse } from 'next/server';
import { POST as planPost } from '../plan/route';

function buildReq(body: unknown): Request {
  return new Request('http://localhost/api/ai-research/plan', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  mocks.requireUser.mockResolvedValue(MOCK_USER);
  mocks.topicFindMany.mockResolvedValue([]);
});
afterEach(() => {
  vi.clearAllMocks();
});

describe('POST /api/ai-research/plan', () => {
  it('认证请求', async () => {
    const unauthorized = new NextResponse(JSON.stringify({ code: 'AUTH_NOT_AUTHENTICATED' }), { status: 401 });
    mocks.requireUser.mockResolvedValueOnce(unauthorized);
    const res = await planPost(buildReq({ question: '我们是否应从 ES 迁移到 OS？' }) as never, ctx());
    expect(res.status).toBe(401);
  });

  it('拒绝空问题', async () => {
    const res = await planPost(buildReq({ question: 'a' }) as never, ctx());
    expect([400, 422]).toContain(res.status);
  });

  it('推断决策类问题为 decide', async () => {
    const res = await planPost(buildReq({ question: '我们是否应从 Elasticsearch 迁移到 OpenSearch？' }) as never, ctx());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.brief.objective).toBe('decide');
    expect(body.plan.steps.length).toBeGreaterThan(0);
    expect(body.plan.steps.map((step: { title: string }) => step.title)).not.toContain('结合历史研判');
    expect(body.plan.steps.map((step: { title: string }) => step.title)).toContain('交叉核对证据');
    expect(body.missingFields).toContain('comparisonOptions');
    expect(body.brief.questionsToAnswer.length).toBeGreaterThan(0);
    expect(body.brief.successCriteria.length).toBeGreaterThan(0);
  });

  it('把中文比较问题识别为决策类调研', async () => {
    const res = await planPost(buildReq({ question: '比较 Claude、Gemini 和 ChatGPT Deep Research 的研究过程设计' }) as never, ctx());
    const body = await res.json();
    expect(body.brief.objective).toBe('decide');
    expect(body.brief.comparisonOptions).toEqual(['Claude', 'Gemini', 'ChatGPT Deep Research']);
    expect(body.missingFields).not.toContain('comparisonOptions');
    expect(body.ready).toBe(true);
  });

  it('推断学习类问题为 learn', async () => {
    const res = await planPost(buildReq({ question: 'GraphRAG 怎么上手？' }) as never, ctx());
    const body = await res.json();
    expect(body.brief.objective).toBe('learn');
  });

  it('推断探索类问题为 explore 且立即 ready', async () => {
    const res = await planPost(buildReq({ question: '最近有哪些 RAG 新趋势？' }) as never, ctx());
    const body = await res.json();
    expect(body.brief.objective).toBe('explore');
    expect(body.ready).toBe(true);
  });

  it('默认推断为 investigate', async () => {
    const res = await planPost(buildReq({ question: '我们想重新评估向量召回链路' }) as never, ctx());
    const body = await res.json();
    expect(body.brief.objective).toBe('investigate');
  });

  it('高分匹配 Topic 会自动选为 primaryTopicId', async () => {
    mocks.topicFindMany.mockResolvedValueOnce([
      {
        id: 'topic-uuid-1',
        slug: 'rag',
        name: 'RAG',
        summary: '检索增强生成',
        candidateCount: 30,
        keywords: ['rag'],
      },
    ]);
    const res = await planPost(buildReq({ question: '调研 RAG 检索增强生成的演进' }) as never, ctx());
    const body = await res.json();
    expect(body.suggestedTopics[0].topicId).toBe('topic-uuid-1');
    expect(body.brief.primaryTopicId).toBe('topic-uuid-1');
  });

  it('explicit primaryTopicId 仍然生效', async () => {
    const res = await planPost(buildReq({
      question: 'GraphRAG',
      primaryTopicId: '22222222-2222-4222-8222-222222222222',
    }) as never, ctx());
    const body = await res.json();
    expect(body.brief.primaryTopicId).toBe('22222222-2222-4222-8222-222222222222');
  });

  it('对缺少用户自定义问题的学习类请求提供可编辑的默认问题', async () => {
    const res = await planPost(buildReq({ question: '我想从零上手 GraphRAG，给个学习路径' }) as never, ctx());
    const body = await res.json();
    expect(body.brief.objective).toBe('learn');
    expect(body.brief.questionsToAnswer.length).toBeGreaterThan(0);
    expect(body.missingFields).not.toContain('questionsToAnswer');
    expect(body.ready).toBe(true);
  });

  it('补全 questionsToAnswer 后 ready=true', async () => {
    const res = await planPost(buildReq({
      questionsToAnswer: ['双写成本如何？', '推理延迟？'],
      question: '我想从零上手 GraphRAG，给个学习路径',
    }) as never, ctx());
    const body = await res.json();
    expect(body.ready).toBe(true);
  });

  it('返回并保留用户确认的检索限定', async () => {
    const res = await planPost(buildReq({
      question: '评估 React 19 在中国团队的适用性',
      scope: {
        timeRange: { preset: '90d' },
        regions: ['中国'],
        technologyVersions: ['React 19'],
      },
    }) as never, ctx());
    const body = await res.json();
    expect(body.brief.scope).toEqual({
      timeRange: { preset: '90d' },
      regions: ['中国'],
      technologyVersions: ['React 19'],
      retrievalNotes: '',
    });
  });
});

function ctx(): { params: Promise<Record<string, string>> } {
  return { params: Promise.resolve({}) };
}
