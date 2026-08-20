// BFF handler: POST /api/ai-research/plan — 调研规划（ADR 0010）。
//
// 输入：question + 可选 constraints / outputType / sourcePolicy
// 输出：ResearchBrief + 匹配 Topic + 建议上下文。
//
// 设计：本地规则推断 + 简单规划。失败时降级到只返回 explore
// 类型的最小 Brief，不阻断用户提交正式调研。

import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { z } from 'zod';

import { apiHandler, parseBody } from '@/lib/api-handler';
import { prisma } from '@/lib/db';
import { requireUser } from '@/lib/auth/session';
import type { ResearchBrief, ResearchPlan } from '@deep-research/shared/schemas';
import type { ResearchObjective } from '@deep-research/shared/states';
import { recordProductEvent } from '@/lib/product-events';

const PlanInput = z.object({
  question: z.string().min(2).max(2000),
  constraints: z.array(z.string().min(1).max(240)).max(20).optional(),
  questionsToAnswer: z.array(z.string().min(1).max(240)).max(20).optional(),
  outputType: z.enum(['markdown', 'slides']).optional(),
  sourcePolicy: z.enum(['prefer_user_sources', 'only_user_sources']).optional(),
  primaryTopicId: z.string().uuid().optional(),
});

const DECIDE_KEYWORDS = /(决策|选型|是否|应不应该|该不该|迁移|上不|还是|vs|vs\.|compare|comparison|选用|采用|替换|落地)/iu;
const INVESTIGATE_KEYWORDS = /(深入|细节|原理|机制|分析|原理是|怎么实现|如何实现|底层|架构|调研|性能|瓶颈|安全|风险|成本)/iu;
const LEARN_KEYWORDS = /(怎么用|如何用|教程|入门|学习|从零|基础|上手|了解)/iu;
const EXPLORE_KEYWORDS = /(概览|概要|有哪些|最近|新出|动态|趋势)/iu;

function inferObjective(question: string): ResearchObjective {
  const text = question.slice(0, 500);
  if (DECIDE_KEYWORDS.test(text)) return 'decide';
  if (INVESTIGATE_KEYWORDS.test(text)) return 'investigate';
  if (LEARN_KEYWORDS.test(text)) return 'learn';
  if (EXPLORE_KEYWORDS.test(text)) return 'explore';
  return 'investigate';
}

function questionToBrief(
  question: string,
  objective: ResearchObjective,
  topicId: string | undefined,
  partial: Partial<ResearchBrief> = {},
): ResearchBrief {
  return {
    objective,
    question: question.slice(0, 2000),
    constraints: partial.constraints ?? [],
    questionsToAnswer: partial.questionsToAnswer ?? [],
    comparisonOptions: partial.comparisonOptions ?? [],
    successCriteria: partial.successCriteria ?? [],
    sourcePolicy: partial.sourcePolicy ?? 'prefer_user_sources',
    contextRefs: partial.contextRefs ?? [],
    primaryTopicId: partial.primaryTopicId ?? topicId,
    outputType: partial.outputType ?? 'markdown',
  };
}

function buildPlanSteps(objective: ResearchObjective, question: string): ResearchPlan {
  const trimmed = question.slice(0, 60);
  if (objective === 'decide') {
    return {
      summary: `围绕「${trimmed}」开展决策类调研，给出选项、利弊与可执行建议。`,
      steps: [
        { title: '梳理备选方案', detail: '枚举主流方案与团队现状匹配点' },
        { title: '对比关键维度', detail: '性能 / 成本 / 学习曲线 / 可运维性 / 风险' },
        { title: '结合历史研判', detail: '纳入本平台已发布相关研究' },
        { title: '给出推荐与下一步', detail: '建议方案 + 验证步骤 + 风险关注点' },
      ],
      estimatedMinutes: 14,
    };
  }
  if (objective === 'learn') {
    return {
      summary: `围绕「${trimmed}」由浅入深整理学习路径。`,
      steps: [
        { title: '核心概念与术语', detail: '梳理关键名词与适用边界' },
        { title: '入门示例与最小实践', detail: '可复制的最小可运行例子' },
        { title: '深入阅读清单', detail: '官方文档与权威案例链接' },
        { title: '常见误区', detail: '总结上手期常见坑' },
      ],
      estimatedMinutes: 12,
    };
  }
  if (objective === 'explore') {
    return {
      summary: `围绕「${trimmed}」快速梳理形态、代表方案与动向。`,
      steps: [
        { title: '近期代表性事件', detail: '最近 30 天关键发布或讨论' },
        { title: '主流玩家与分类', detail: '列出代表性项目或方案' },
        { title: '与团队相关度', detail: '一句话评估本团队是否需要进一步评估' },
      ],
      estimatedMinutes: 5,
    };
  }
  return {
    summary: `围绕「${trimmed}」开展深入调研并整理可证据化判断。`,
    steps: [
      { title: '现状与机制', detail: '梳理概念、原理、典型架构' },
      { title: '证据收集', detail: '官方资料、权威社区、生产案例' },
      { title: '风险与权衡', detail: '性能、可运维性、安全、迁移成本' },
      { title: '结论与下一步', detail: '明确可执行结论与验证步骤' },
    ],
    estimatedMinutes: 18,
  };
}

async function matchTopics(question: string, topicIdHint?: string): Promise<
  Array<{ topicId: string; slug: string; name: string; confidence: number }>
> {
  const tokens = Array.from(
    new Set(
      question
        .toLowerCase()
        .match(/[\p{L}\p{N}][\p{L}\p{N}-]{1,24}/gu)
        ?.filter((t) => t.length >= 2) ?? [],
    ),
  ).slice(0, 8);

  const candidates = await prisma.topic.findMany({
    where: {
      enabled: true,
      OR: tokens.flatMap((t) => [
        { name: { contains: t, mode: 'insensitive' as const } },
        { slug: { contains: t } },
      ]),
    },
    take: 8,
    select: { id: true, slug: true, name: true, summary: true, candidateCount: true, keywords: true },
  });

  const scored = candidates
    .map((c) => {
      const name = c.name.toLowerCase();
      const matchedTokens = tokens.filter((t) => name.includes(t) || c.slug.includes(t));
      const kwHit = Array.isArray(c.keywords)
        ? tokens.filter((t) => (c.keywords as unknown[]).includes(t)).length
        : 0;
      const base = matchedTokens.length * 0.5 + kwHit * 0.2 + Math.min(c.candidateCount, 50) / 200;
      return {
        topicId: c.id,
        slug: c.slug,
        name: c.name,
        confidence: Math.min(0.99, 0.1 + base),
      };
    })
    .filter((m) => m.confidence >= 0.25)
    .sort((a, b) => b.confidence - a.confidence)
    .slice(0, 4);

  if (topicIdHint) {
    const exact = await prisma.topic.findUnique({
      where: { id: topicIdHint },
      select: { id: true, slug: true, name: true },
    });
    if (exact && !scored.some((s) => s.topicId === exact.id)) {
      scored.unshift({ ...exact, confidence: 0.95, topicId: exact.id });
    }
  }
  return scored;
}

async function suggestContext(
  userId: string,
  question: string,
): Promise<Array<{ kind: 'research' | 'knowledge' | 'issue'; id: string; title: string; snippet: string }>> {
  const rows = await prisma.research.findMany({
    where: {
      authorId: userId,
      title: { contains: question.slice(0, 60), mode: 'insensitive' },
    },
    take: 5,
    select: { id: true, title: true, body: true, type: true },
  });
  return rows.map((r) => ({
    kind: r.type === 'knowledge' ? 'knowledge' : 'research',
    id: r.id,
    title: r.title,
    snippet: (r.body ?? '').slice(0, 240),
  }));
}

export const dynamic = 'force-dynamic';

export const POST = apiHandler<[NextRequest, { params: Promise<Record<string, string>> }]>(async (req) => {
  const u = await requireUser(req);
  if (u instanceof NextResponse) return u;

  const body = await parseBody(req, PlanInput);
  if (body instanceof NextResponse) return body;

  const question = body.question.trim();
  const objective = inferObjective(question);

  const topics = await matchTopics(question, body.primaryTopicId);
  const primary = topics[0]?.topicId ?? body.primaryTopicId;

  const brief = questionToBrief(question, objective, primary, {
    constraints: body.constraints,
    questionsToAnswer: body.questionsToAnswer,
    outputType: body.outputType,
    sourcePolicy: body.sourcePolicy,
  });

  const plan = buildPlanSteps(objective, question);
  const missingFields: string[] = [];
  if (objective === 'decide' && brief.comparisonOptions.length === 0) {
    missingFields.push('comparisonOptions');
  }
  if (objective !== 'explore' && brief.questionsToAnswer.length === 0) {
    missingFields.push('questionsToAnswer');
  }

  const suggestedContext = await suggestContext(u.id, question);

  // V2 闭环：plan 返回 ready=true = 调研计划已被用户确认到「可执行」状态
  if (missingFields.length === 0) {
    await recordProductEvent({
      userId: u.id,
      eventType: 'research_plan_confirmed',
      targetType: 'research_brief',
      targetId: undefined,
      metadata: {
        objective,
        questionLength: question.length,
        hasSuggestedContext: suggestedContext.length > 0,
      },
    }).catch(() => undefined);
  }

  return NextResponse.json({
    assistantMessage:
      objective === 'explore'
        ? '这是快速概览，可以直接启动。'
        : `判断为「${objective}」类调研。请确认研究计划后启动。`,
    brief,
    plan,
    ready: missingFields.length === 0,
    missingFields,
    suggestedTopics: topics,
    suggestedContext,
  });
});
