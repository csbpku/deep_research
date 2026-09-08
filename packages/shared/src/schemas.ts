import { z } from 'zod';
import { SUMMARY_STATUS, CREATION_METHOD, SOURCE_POLICY, PROMOTE_STATUS } from './states';

export const DistilledTierSchema = z.enum(['collection', 'deep_read', 'skim', 'noise']);
export const DistilledProfileSchema = z.enum(['paper', 'engineering', 'news']);
export const DistilledDimensionScoresSchema = z.object({
  informationGain: z.number().int().min(0).max(3),
  analysisDepth: z.number().int().min(0).max(3),
  actionability: z.number().int().min(0).max(3),
  factualReliability: z.number().int().min(0).max(3),
  currentApplicability: z.number().int().min(0).max(3),
  expressionQuality: z.number().int().min(0).max(3),
  audienceFit: z.number().int().min(0).max(3),
}).strict();
export const DistilledScoreSchema = z.object({
  total: z.number().min(0).max(100),
  effectiveTotal: z.number().min(0).max(100).optional(),
  qualityScore: z.number().min(0).max(100).optional(),
  teamValueScore: z.number().min(0).max(100).optional(),
  rankingScore: z.number().min(0).max(100).optional(),
  tierScore: z.number().min(0).max(100).optional(),
  sourceBonus: z.number().min(0).max(20).optional(),
  tier: DistilledTierSchema,
  dimensions: DistilledDimensionScoresSchema,
  weakPoint: z.string().max(100),
  veto: z.enum(['unsafe_content', 'title_content_mismatch']).nullable(),
  riskFlags: z.array(z.enum(['security_review_required', 'suspected_repost'])),
  profile: DistilledProfileSchema,
  profileFallback: z.boolean().optional(),
  isDefault: z.boolean(),
  version: z.string().min(1).max(16),
  directRelevance: z.number().int().min(0).max(3).optional(),
  relevanceEvidence: z.string().max(240).optional(),
}).strict();
export type DistilledScore = z.infer<typeof DistilledScoreSchema>;

// Zod schema：API 输入约束。详细定义见 docs/contracts/api-schemas.md。

const SourceRefUrl = z.object({
  type: z.literal('url'),
  value: z.string().url().max(2048),
  required: z.boolean().default(false),
});
const SourceRefUuid = (literal: 'favorite' | 'research' | 'summary') => z.object({
  type: z.literal(literal),
  value: z.string().uuid(),
  required: z.boolean().default(false),
});

/** 提交 AI 调研任务（架构 §十三） */
const AiResearchConversationMessage = z.object({
  id: z.string().max(160),
  role: z.enum(['user', 'assistant']),
  content: z.string().max(4000),
});

export const CreateAiJobInput = z.object({
  topic: z.string().min(2).max(200),
  context: z.string().max(2000).optional(),                    // 用户手填上下文
  reportType: z.enum(['research_report', 'summary_brief', 'slides', 'web_brief']).default('research_report'),
  // P1.8: reportLength scales gpt-researcher's TOTAL_WORDS / MAX_URLS_TO_SCRAPE.
  // brief  = ~500 words / 5 URLs  (default for summary_brief)
  // standard = 800 words / 10 URLs (legacy default for research_report)
  // deep   = ~3600 words / 48 URLs (deep dive)
  // The mapping lives in ai_engine.adapters.gpt_researcher; the API just
  // echoes the user's pick back so the FE can render progress in real time.
  reportLength: z.enum(['brief', 'standard', 'deep']).default('standard'),
  sourcePolicy: z.enum([SOURCE_POLICY.PREFER_USER_SOURCES, SOURCE_POLICY.ONLY_USER_SOURCES])
    .default(SOURCE_POLICY.PREFER_USER_SOURCES),
  // P1.8: explicit URL-scrape cap override (5..48). When unset, the value
  // is derived from reportLength.
  maxUrlsToScrape: z.number().int().min(5).max(48).optional(),
  sourceRefs: z.array(z.discriminatedUnion('type', [
    SourceRefUrl,
    SourceRefUuid('favorite'),
    SourceRefUuid('research'),
    SourceRefUuid('summary'),
  ])).max(10).default([]),
  idempotencyKey: z.string().uuid().optional(),
  conversationId: z.string().uuid().optional(),
  conversation: z.array(AiResearchConversationMessage).max(100).optional(),
});
export type CreateAiJobInput = z.infer<typeof CreateAiJobInput>;

/** 文件导入请求（架构 §四点七） */
export const CreateFileImportInput = z.object({
  filename: z.string().min(1).max(255),
  mimeType: z.enum(['text/markdown', 'text/plain', 'text/html']),
  sizeBytes: z.number().int().positive().max(5 * 1024 * 1024),
});
export type CreateFileImportInput = z.infer<typeof CreateFileImportInput>;

/** 用户分享 URL（架构 §九 风险 5） */
export const ShareUrlInput = z.object({
  url: z.string().url().max(2048),
  userNote: z.string().max(500).optional(),
});
export type ShareUrlInput = z.infer<typeof ShareUrlInput>;

/** 评论创建（架构 §十四） */
export const CreateCommentInput = z.object({
  targetType: z.enum(['research', 'summary']),
  targetId: z.string().uuid(),
  body: z.string().min(1).max(2000),
  // 评论可显式挂到一个父评论（实现 P1）
  parentId: z.string().uuid().optional(),
});
export type CreateCommentInput = z.infer<typeof CreateCommentInput>;

/** Admin 审批（架构 §十七） */
const KnowledgeDraft = z.object({
  title: z.string().min(2).max(200),
  body: z.string().min(20).max(2000),
  tags: z.array(z.string().min(1).max(40)).max(10).default([]),
});
export type KnowledgeDraft = z.infer<typeof KnowledgeDraft>;

export const AdminApprovalInput = z.object({
  targetType: z.enum(['share_summary', 'nominated_comment']),
  targetId: z.string().uuid(),
  decision: z.enum(['approve', 'reject']),
  // 仅 nominated_comment + approve 时必填；其余组合可选
  knowledgeDraft: KnowledgeDraft.optional(),
}).superRefine((data, ctx) => {
  if (data.targetType === 'nominated_comment' && data.decision === 'approve') {
    if (!data.knowledgeDraft) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['knowledgeDraft'],
        message: 'nominated_comment + approve 必须提供 knowledgeDraft',
      });
    }
  }
});
export type AdminApprovalInput = z.infer<typeof AdminApprovalInput>;

/** 详情有效阅读事件；eventName/userId/occurredAt 由服务端填写。 */
export const DetailReadCompletedInput = z.object({
  entityType: z.enum(['summary', 'research']),
  entityId: z.string().uuid(),
  foregroundSeconds: z.number().int().min(30).max(86_400),
  scrollPercent: z.number().min(50).max(100),
  idempotencyKey: z.string().uuid(),
});
export type DetailReadCompletedInput = z.infer<typeof DetailReadCompletedInput>;

/** succeeded research job 的节省时间反馈。 */
export const RecordTimeSavedInput = z.object({
  jobId: z.string().uuid(),
  minutes: z.number().int().min(0).max(240),
  idempotencyKey: z.string().uuid(),
});
export type RecordTimeSavedInput = z.infer<typeof RecordTimeSavedInput>;

// ADR 0010: Research Brief + 扩展的 AI 调研入参

import { RESEARCH_OBJECTIVE, RESEARCH_OUTPUT_TYPE } from './states';
const SourceRefUrlV2 = z.object({
  type: z.literal('url'),
  value: z.string().url().max(2048),
  required: z.boolean().default(false),
});
const SourceRefUuidV2 = (literal: 'favorite' | 'research' | 'summary') => z.object({
  type: z.literal(literal),
  value: z.string().uuid(),
  required: z.boolean().default(false),
});

export const ResearchObjectiveSchema = z.enum([
  RESEARCH_OBJECTIVE.EXPLORE,
  RESEARCH_OBJECTIVE.LEARN,
  RESEARCH_OBJECTIVE.INVESTIGATE,
  RESEARCH_OBJECTIVE.DECIDE,
]);

export const ResearchOutputTypeSchema = z.enum([
  RESEARCH_OUTPUT_TYPE.MARKDOWN,
  RESEARCH_OUTPUT_TYPE.SLIDES,
  RESEARCH_OUTPUT_TYPE.WEB,
]);

/**
 * 用户在启动研究前确认的检索范围。
 *
 * 资料来源由 sourcePolicy / contextRefs 控制；这里的 scope 是检索上下文，
 * 会随 brief 保存并传给研究引擎。retrievalNotes 用自然语言承载少量项目特定
 * 的限定，避免要求所有研究都理解“地区”或“技术版本”这类并非总是适用的字段。
 */
export const ResearchTimeRangeSchema = z.object({
  preset: z.enum(['any', '7d', '30d', '90d', '1y', 'custom']).default('any'),
  from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/u, '日期格式必须为 YYYY-MM-DD').optional(),
  to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/u, '日期格式必须为 YYYY-MM-DD').optional(),
}).superRefine((value, ctx) => {
  if (value.preset === 'custom' && (!value.from || !value.to)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['from'], message: '自定义时间范围需要起止日期' });
  }
  if (value.from && value.to && value.from > value.to) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['to'], message: '结束日期不能早于开始日期' });
  }
});
export type ResearchTimeRange = z.infer<typeof ResearchTimeRangeSchema>;

export const ResearchScopeSchema = z.object({
  timeRange: ResearchTimeRangeSchema.default({ preset: 'any' }),
  regions: z.array(z.string().trim().min(1).max(60)).max(8).default([]),
  technologyVersions: z.array(z.string().trim().min(1).max(80)).max(8).default([]),
  retrievalNotes: z.string().trim().max(400).default(''),
}).default({
  timeRange: { preset: 'any' },
  regions: [],
  technologyVersions: [],
  retrievalNotes: '',
});
export type ResearchScope = z.infer<typeof ResearchScopeSchema>;

export const ResearchBriefSchema = z.object({
  objective: ResearchObjectiveSchema,
  question: z.string().min(2).max(2000),
  scope: ResearchScopeSchema,
  constraints: z.array(z.string().min(1).max(240)).max(20).default([]),
  questionsToAnswer: z.array(z.string().min(1).max(240)).max(20).default([]),
  comparisonOptions: z.array(z.string().min(1).max(240)).max(20).default([]),
  successCriteria: z.array(z.string().min(1).max(240)).max(20).default([]),
  sourcePolicy: z.enum(['prefer_user_sources', 'only_user_sources'])
    .default('prefer_user_sources'),
  contextRefs: z.array(z.discriminatedUnion('type', [
    SourceRefUrlV2,
    SourceRefUuidV2('favorite'),
    SourceRefUuidV2('research'),
    SourceRefUuidV2('summary'),
  ])).max(10).default([]),
  primaryTopicId: z.string().uuid().optional(),
  outputType: ResearchOutputTypeSchema.default('markdown'),
});
export type ResearchBrief = z.infer<typeof ResearchBriefSchema>;

export const ResearchPlanStepSchema = z.object({
  title: z.string().min(1).max(240),
  detail: z.string().max(800),
});
export const ResearchPlanSchema = z.object({
  summary: z.string().max(500),
  steps: z.array(ResearchPlanStepSchema).max(12),
  estimatedMinutes: z.number().int().min(1).max(120),
});
export type ResearchPlan = z.infer<typeof ResearchPlanSchema>;

/** v2 入参：兼容 v1，老客户端可用旧字段。 */
export const CreateAiJobInputV2 = z.object({
  topic: z.string().min(2).max(200).optional(),
  // v2 以 brief 为准，但允许保留旧 topic/context/reportType 等以便老调用不变。
  brief: ResearchBriefSchema.optional(),
  context: z.string().max(2000).optional(),
  reportType: z.enum(['research_report', 'summary_brief', 'slides', 'web_brief']).default('research_report'),
  reportLength: z.enum(['brief', 'standard', 'deep']).default('standard'),
  sourcePolicy: z.enum(['prefer_user_sources', 'only_user_sources']).default('prefer_user_sources'),
  maxUrlsToScrape: z.number().int().min(5).max(48).optional(),
  sourceRefs: z.array(z.discriminatedUnion('type', [
    SourceRefUrlV2,
    SourceRefUuidV2('favorite'),
    SourceRefUuidV2('research'),
    SourceRefUuidV2('summary'),
  ])).max(10).default([]),
  idempotencyKey: z.string().uuid().optional(),
  primaryTopicId: z.string().uuid().optional(),
  conversationId: z.string().uuid().optional(),
  conversation: z.array(AiResearchConversationMessage).max(100).optional(),
});
export type CreateAiJobInputV2 = z.infer<typeof CreateAiJobInputV2>;

// /api/ai-research/plan 响应
export interface ResearchPlanResponse {
  assistantMessage: string;
  brief: ResearchBrief;
  plan?: ResearchPlan;
  ready: boolean;
  missingFields: string[];
  suggestedTopics: Array<{
    topicId: string;
    slug: string;
    name: string;
    confidence: number;
  }>;
  suggestedContext: Array<{
    kind: 'research' | 'knowledge' | 'issue' | 'bookmark';
    id: string;
    title: string;
    snippet: string;
  }>;
}
