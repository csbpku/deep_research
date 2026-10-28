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
  topicFindUnique: vi.fn(),
  researchFindMany: vi.fn(),
}));

vi.mock('@/lib/auth/session', () => ({
  requireUser: mocks.requireUser,
  getCurrentUser: vi.fn(async () => MOCK_USER),
}));
vi.mock('@/lib/db', () => ({
  prisma: {
    topic: { findMany: mocks.topicFindMany, findUnique: mocks.topicFindUnique },
    research: { findMany: mocks.researchFindMany },
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
  vi.resetAllMocks();
  mocks.requireUser.mockResolvedValue(MOCK_USER);
  mocks.topicFindMany.mockResolvedValue([]);
  mocks.topicFindUnique.mockResolvedValue(null);
  mocks.researchFindMany.mockResolvedValue([]);
});
afterEach(() => {
  vi.clearAllMocks();
});

describe('POST /api/ai-research/plan', () => {
  it('preserves the complete question and accumulated context', async () => {
    const question = '学习 Grok Bot。' + '需要研究的细节。'.repeat(500);
    const context = '已有背景。'.repeat(1000) + '最新补充要求';
    const res = await planPost(buildReq({ question, context }) as never, ctx());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.brief.question).toBe(question);
    expect(body.brief.context).toBe(context);
  });

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

  it('从 vs 问题中提取两个对比方案', async () => {
    const res = await planPost(buildReq({
      question: 'GHCR 固定 SHA 镜像 vs VPS 本地构建：比较带宽、回滚和磁盘空间',
    }) as never, ctx());
    const body = await res.json();
    expect(body.brief.objective).toBe('decide');
    expect(body.brief.comparisonOptions).toEqual(['GHCR 固定 SHA 镜像', 'VPS 本地构建']);
    expect(body.missingFields).not.toContain('comparisonOptions');
  });

  it('keeps scenario and requested advice out of the real Playwright comparison options', async () => {
    const res = await planPost(buildReq({
      question: '比较 Playwright 和 Cypress 在小型 TypeScript 团队端到端测试中的选择，给出适用边界与建议',
    }) as never, ctx());
    const body = await res.json();
    expect(body.brief.comparisonOptions).toEqual(['Playwright', 'Cypress']);
    expect(body.ready).toBe(true);
  });

  it('extracts compact Chinese and English comparison names without swallowing requirements', async () => {
    for (const question of [
      '比较Playwright和Cypress的工程取舍，给出建议',
      'Compare Playwright and Cypress for a small TypeScript team, provide trade-offs.',
    ]) {
      const res = await planPost(buildReq({ question }) as never, ctx());
      expect((await res.json()).brief.comparisonOptions).toEqual(['Playwright', 'Cypress']);
    }
  });

  it('preserves quoted names containing conjunctions, commas and colons', async () => {
    const cases = [
      ['比较「Research and Development」和「MLflow」的工程取舍', ['Research and Development', 'MLflow']],
      ['Compare "A: Research and Development" and "B, Inc." for a small team', ['A: Research and Development', 'B, Inc.']],
    ] as const;
    for (const [question, options] of cases) {
      const res = await planPost(buildReq({ question }) as never, ctx());
      expect((await res.json()).brief.comparisonOptions).toEqual(options);
    }
  });

  it('does not strip a conjunction character from the beginning of a named product', async () => {
    const res = await planPost(buildReq({ question: '比较 和鲸 ModelWhale 和 JupyterLab 的工程取舍' }) as never, ctx());
    expect((await res.json()).brief.comparisonOptions).toEqual(['和鲸 ModelWhale', 'JupyterLab']);
  });

  it('asks for named comparison options instead of treating vague instructions as products', async () => {
    const res = await planPost(buildReq({ question: '比较现有方案与更好的实现，给出适用边界与建议' }) as never, ctx());
    const body = await res.json();
    expect(body.brief.comparisonOptions).toEqual([]);
    expect(body.missingFields).toContain('comparisonOptions');
    expect(body.ready).toBe(false);
    expect(body.assistantMessage).toContain('对比对象');
    expect(body.assistantMessage).not.toContain('comparisonOptions');
  });

  it('uses the requested runtime behaviours rather than imposing operational comparison dimensions', async () => {
    const res = await planPost(buildReq({
      question: '比较 asyncio.gather 和 asyncio.TaskGroup 的异常传播和取消行为差异，说明适用边界',
    }) as never, ctx());
    const body = await res.json();
    expect(body.brief.comparisonOptions).toEqual(['asyncio.gather', 'asyncio.TaskGroup']);
    expect(body.brief.decisionDimensions).toEqual(expect.arrayContaining(['异常传播', '取消行为']));
    expect(body.brief.decisionDimensions).not.toEqual(expect.arrayContaining(['磁盘与资源占用']));
    expect(body.brief.decisionDimensions).not.toContain('部署与构建');
    expect(body.brief.decisionDimensions).not.toContain('回滚与恢复');
    expect(body.brief.decisionDimensions).not.toContain('网络/性能实测');
    expect(body.plan.steps.find((step: { title: string }) => step.title === '对比关键维度').detail).toContain('异常传播');
  });

  it('retains the operational evidence requirements when the question explicitly requests them', async () => {
    const res = await planPost(buildReq({
      question: 'GHCR 固定 SHA 镜像 vs VPS 本地构建：比较带宽、回滚和磁盘空间',
    }) as never, ctx());
    expect((await res.json()).brief.decisionDimensions).toEqual(expect.arrayContaining([
      '网络/性能实测', '磁盘与资源占用', '部署与构建', '回滚与恢复',
    ]));
  });

  it('does not infer dimensions that the user explicitly excludes', async () => {
    const res = await planPost(buildReq({
      question: '比较 asyncio.gather 和 asyncio.TaskGroup 的异常传播；不讨论部署、磁盘和回滚',
    }) as never, ctx());
    const body = await res.json();
    expect(body.brief.decisionDimensions).toContain('异常传播');
    expect(body.brief.decisionDimensions).not.toContain('部署与构建');
    expect(body.brief.decisionDimensions).not.toContain('磁盘与资源占用');
    expect(body.brief.decisionDimensions).not.toContain('回滚与恢复');
  });

  it('keeps a positive requirement after an excluded topic clause', async () => {
    const res = await planPost(buildReq({
      question: '比较 Playwright 和 Cypress，不讨论部署和磁盘，但需要性能实测',
    }) as never, ctx());
    const body = await res.json();
    expect(body.brief.decisionDimensions).toContain('网络/性能实测');
    expect(body.brief.decisionDimensions).not.toContain('部署与构建');
    expect(body.brief.decisionDimensions).not.toContain('磁盘与资源占用');
  });

  it('respects the real acceptance request not to expand into unrelated operational topics', async () => {
    for (const exclusion of [
      '不展开无关的部署、磁盘或回滚',
      '不延伸到部署、磁盘或回滚',
      '不扩展到部署、磁盘或回滚',
    ]) {
      const res = await planPost(buildReq({
        question: `【最终验收】比较 Python asyncio.gather 和 asyncio.TaskGroup 的异常传播与取消行为。仅使用指定官方文档，先给直接结论，再给行为对照及引用；控制在1000字内，${exclusion}。`,
        context: '直接比较首个异常传播与其他任务是否取消；区分 return_exceptions 和用户取消。',
      }) as never, ctx());
      expect((await res.json()).brief.decisionDimensions).toEqual(['异常传播', '取消行为']);
    }
  });

  it('does not restore an explicitly excluded dimension through the fallback defaults', async () => {
    const res = await planPost(buildReq({ question: '比较 A 和 B，不讨论安全风险' }) as never, ctx());
    expect((await res.json()).brief.decisionDimensions).not.toContain('安全与风险');
  });

  it('does not mistake do-not-ignore instructions for excluded topics', async () => {
    const res = await planPost(buildReq({ question: '比较 A 和 B，不要忽略性能和安全风险' }) as never, ctx());
    expect((await res.json()).brief.decisionDimensions).toEqual(expect.arrayContaining(['网络/性能实测', '安全与风险']));
  });

  it('preserves explicitly supplied comparison options and dimensions, including an empty dimension list', async () => {
    for (const decisionDimensions of [['异常传播'], []]) {
      const res = await planPost(buildReq({
        question: '比较 Playwright 和 Cypress 的工程取舍',
        comparisonOptions: ['Explicit A', 'Explicit B'],
        decisionDimensions,
      }) as never, ctx());
      const body = await res.json();
      expect(body.brief.comparisonOptions).toEqual(['Explicit A', 'Explicit B']);
      expect(body.brief.decisionDimensions).toEqual(decisionDimensions);
    }
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

  it('uses topicHint to discover past judgments without adopting their sources', async () => {
    const topicId = '22222222-2222-4222-8222-222222222222';
    mocks.topicFindUnique.mockResolvedValueOnce({ id: topicId, slug: 'retrieval', name: '检索', enabled: true });
    mocks.researchFindMany.mockResolvedValueOnce([{
      id: '33333333-3333-4333-8333-333333333333', type: 'knowledge',
      title: '此前确认的工程取舍', body: 'Reader 原文不是用户确认的判断',
      knowledgeIndexText: '先保留已有架构。', conclusion: null, background: null,
      authorId: MOCK_USER.id, status: 'draft', researchTopics: [{ topicId }],
      updatedAt: new Date('2026-10-19T00:00:00Z'),
    }]);
    const res = await planPost(buildReq({ question: '接下来怎么验证新方案', topicHint: topicId }) as never, ctx());
    const body = await res.json();
    expect(body.brief.primaryTopicId).toBe(topicId);
    expect(body.suggestedContext[0]).toMatchObject({
      kind: 'knowledge', confirmedKnowledge: true, private: true, topicMatch: true,
      status: 'draft', snippet: '先保留已有架构。', updatedAt: '2026-10-19T00:00:00.000Z',
      sourceRefs: [{ type: 'research', value: '33333333-3333-4333-8333-333333333333', required: false }],
    });
    expect(body.brief.contextRefs).toEqual([]);
    expect(JSON.stringify(body.suggestedContext)).not.toContain('Reader 原文');
    expect(mocks.researchFindMany.mock.calls[0][0].where).toMatchObject({
      authorId: MOCK_USER.id, status: { in: ['draft', 'published'] }, knowledgeIndexText: { not: null },
    });
  });

  it('uses bounded Chinese keywords, and excludes archived/other private suggestions', async () => {
    mocks.researchFindMany.mockResolvedValueOnce([]).mockResolvedValueOnce([
      {
        id: 'archived', title: '向量检索成本', body: '', type: 'research', authorId: MOCK_USER.id,
        status: 'archived', knowledgeIndexText: null, researchTopics: [], updatedAt: new Date(),
      },
      {
        id: 'other-private', title: '向量检索成本', body: '', type: 'research', authorId: 'another-user',
        status: 'draft', knowledgeIndexText: null, researchTopics: [], updatedAt: new Date(),
      },
    ]);
    const question = '我们是否应该重新评估向量检索成本？';
    const res = await planPost(buildReq({ question }) as never, ctx());
    const body = await res.json();
    expect(body.suggestedContext).toEqual([]);
    const researchQuery = mocks.researchFindMany.mock.calls[1][0];
    expect(researchQuery.take).toBe(24);
    expect(JSON.stringify(researchQuery.where)).not.toContain(question);
    expect(JSON.stringify(researchQuery.where)).toContain('检索');
    expect(JSON.stringify(mocks.topicFindMany.mock.calls[0][0])).toContain('检索');
  });

  it('an explicit primaryTopicId takes precedence over topicHint and inferred topics', async () => {
    mocks.topicFindMany.mockResolvedValueOnce([{
      id: 'inferred-topic', slug: 'rag', name: 'RAG', candidateCount: 30, keywords: ['rag'],
    }]);
    const primaryTopicId = '22222222-2222-4222-8222-222222222222';
    const res = await planPost(buildReq({
      question: 'RAG 检索增强生成',
      primaryTopicId,
      topicHint: '44444444-4444-4444-8444-444444444444',
    }) as never, ctx());
    const body = await res.json();
    expect(body.brief.primaryTopicId).toBe(primaryTopicId);
    expect(mocks.topicFindUnique).toHaveBeenCalledWith(expect.objectContaining({ where: { id: primaryTopicId } }));
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
