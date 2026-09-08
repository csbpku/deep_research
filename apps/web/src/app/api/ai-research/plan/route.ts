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
import { ResearchScopeSchema, type ResearchBrief, type ResearchPlan, type ResearchScope } from '@deep-research/shared/schemas';
import type { ResearchObjective } from '@deep-research/shared/states';
import { recordProductEvent } from '@/lib/product-events';

const PlanInput = z.object({
  question: z.string().min(2).max(2000),
  constraints: z.array(z.string().min(1).max(240)).max(20).optional(),
  questionsToAnswer: z.array(z.string().min(1).max(240)).max(20).optional(),
  scope: ResearchScopeSchema.optional(),
  outputType: z.enum(['markdown', 'slides', 'web']).optional(),
  sourcePolicy: z.enum(['prefer_user_sources', 'only_user_sources']).optional(),
  primaryTopicId: z.string().uuid().optional(),
});

const DECIDE_KEYWORDS = /(决策|选型|是否|应不应该|该不该|迁移|上不|还是|比较|对比|区别|优劣|vs|vs\.|compare|comparison|选用|采用|替换|落地)/iu;
const INVESTIGATE_KEYWORDS = /(深入|细节|原理|机制|分析|原理是|怎么实现|如何实现|底层|架构|调研|性能|瓶颈|安全|风险|成本)/iu;
const LEARN_KEYWORDS = /(怎么用|如何用|教程|入门|学习|从零|基础|上手|了解)/iu;
const EXPLORE_KEYWORDS = /(概览|概要|有哪些|最近|新出|动态|趋势)/iu;

const OBJECTIVE_LABELS: Record<ResearchObjective, string> = {
  explore: '快速概览',
  learn: '系统学习',
  investigate: '深入调研',
  decide: '决策对比',
};

function inferObjective(question: string): ResearchObjective {
  const text = question.slice(0, 500);
  if (DECIDE_KEYWORDS.test(text)) return 'decide';
  if (INVESTIGATE_KEYWORDS.test(text)) return 'investigate';
  if (LEARN_KEYWORDS.test(text)) return 'learn';
  if (EXPLORE_KEYWORDS.test(text)) return 'explore';
  return 'investigate';
}

function splitPlanItems(value: string): string[] {
  return value
    .split(/、|，|,|；|;|\s+(?:和|与|以及|及|vs\.?|versus)\s+/iu)
    .map((item) => item
      .replace(/^(?:比较|对比|compare)\s*/iu, '')
      // A comparison question usually appends the dimension after the last
      // option: “比较 A、B 和 C 的研究过程设计”. Keep the option name and
      // remove only that trailing comparison dimension; otherwise the plan
      // presents “C 的研究过程设计” as if it were a fourth product.
      .replace(/\s*(?:的)?(?:工程取舍|研究过程(?:设计)?|研究能力|产品能力|优劣|区别|差异|对比|比较)$/iu, '')
      .trim())
    .filter((item) => item.length >= 2 && item.length <= 80)
    .slice(0, 8);
}

function inferComparisonOptions(question: string): string[] {
  const comparison = question.match(/(?:比较|对比|compare)\s+(.+?)(?=[:：。！？!?]|$)/iu);
  if (!comparison) return [];
  return Array.from(new Set(splitPlanItems(comparison[1])));
}

function defaultQuestionsToAnswer(objective: ResearchObjective): string[] {
  if (objective === 'decide') {
    return [
      '每个候选方案解决什么问题，适用前提是什么？',
      '在效果、成本、实现与运维风险上，有哪些可核对的差异？',
      '哪些关键判断有直接来源支持，哪些仍存在证据缺口或冲突？',
      '结合当前场景，推荐什么选择，下一步如何用最小成本验证？',
    ];
  }
  if (objective === 'learn') {
    return [
      '核心概念、工作机制和必要前置知识是什么？',
      '怎样用最小实践验证理解，官方资料推荐的路径是什么？',
      '常见误区、限制和失败信号有哪些？',
    ];
  }
  if (objective === 'explore') {
    return [
      '当前有哪些代表性方案或变化，分别解决什么问题？',
      '哪些信息已经由直接来源确认，哪些仍值得继续跟踪？',
    ];
  }
  return [
    '它的核心机制、工作流程和适用边界是什么？',
    '主要收益、限制、失败模式和工程代价是什么？',
    '哪些关键判断有直接来源支持，哪些仍需要进一步验证？',
    '对当前项目有哪些可执行的借鉴或验证步骤？',
  ];
}

function defaultSuccessCriteria(objective: ResearchObjective): string[] {
  const criteria = [
    '重要判断都能回链到可检查的原文或明确标记为待核验',
    '清楚区分已确认事实、基于证据的推断和建议',
    '保留主要限制、反例与尚未解决的证据缺口',
  ];
  if (objective === 'decide') {
    criteria.push('给出与当前场景相关的推荐和下一步验证动作');
  }
  return criteria;
}

function questionToBrief(
  question: string,
  objective: ResearchObjective,
  topicId: string | undefined,
  partial: Partial<ResearchBrief> & { scope?: ResearchScope } = {},
): ResearchBrief {
  return {
    objective,
    question: question.slice(0, 2000),
    scope: partial.scope ?? ResearchScopeSchema.parse({}),
    constraints: partial.constraints ?? [],
    questionsToAnswer: partial.questionsToAnswer ?? defaultQuestionsToAnswer(objective),
    comparisonOptions: partial.comparisonOptions ?? inferComparisonOptions(question),
    successCriteria: partial.successCriteria ?? defaultSuccessCriteria(objective),
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
        { title: '交叉核对证据', detail: '优先查找第一方资料，并标出冲突与缺口' },
        { title: '给出推荐与下一步', detail: '建议方案 + 最小验证步骤 + 风险关注点' },
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
        { title: '并行收集证据', detail: '覆盖官方资料、工程实践和反例' },
        { title: '风险与权衡', detail: '性能、可运维性、安全、迁移成本' },
        { title: '结论与下一步', detail: '明确证据强度、缺口与验证步骤' },
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

  // Topic matching and personal-context suggestions are independent reads.
  // Run them together so a slow history query does not add another full
  // round-trip before the user can review or start the research.
  const [topics, suggestedContext] = await Promise.all([
    matchTopics(question, body.primaryTopicId),
    suggestContext(u.id, question),
  ]);
  const primary = topics[0]?.topicId ?? body.primaryTopicId;

  const brief = questionToBrief(question, objective, primary, {
    constraints: body.constraints,
    questionsToAnswer: body.questionsToAnswer,
    scope: body.scope,
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
        : missingFields.length === 0
          ? `判断为「${OBJECTIVE_LABELS[objective]}」类调研。研究计划已生成，可以直接启动。`
          : `判断为「${OBJECTIVE_LABELS[objective]}」类调研。建议补充：${missingFields.map((field) => field).join('、')}；也可以直接开始，AI 会按现有范围执行。`,
    brief,
    plan,
    ready: missingFields.length === 0,
    missingFields,
    suggestedTopics: topics,
    suggestedContext,
  });
});
