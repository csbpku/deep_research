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

// 原网页阅读助手契约。正文由浏览器按需提取，服务端只在请求生命周期内处理。
export const ReadingActionSchema = z.enum(['explain', 'translate', 'ask']);
export type ReadingAction = z.infer<typeof ReadingActionSchema>;

export const ReadingContextScopeSchema = z.enum(['selection', 'section', 'page']);
export type ReadingContextScope = z.infer<typeof ReadingContextScopeSchema>;

const ReadingUrlSchema = z.string().url().max(2048).refine(
  (value) => /^https?:\/\//u.test(value),
  '原网页阅读只支持 HTTP(S) 页面',
);

export const SourceAnchorSchema = z.object({
  quote: z.string().min(1).max(12_000),
  prefix: z.string().max(500).default(''),
  suffix: z.string().max(500).default(''),
  startOffset: z.number().int().min(0).optional(),
  endOffset: z.number().int().min(0).optional(),
  contentHash: z.string().regex(/^[a-f0-9]{64}$/u).optional(),
  selectorPath: z.string().max(1000).optional(),
}).strict().superRefine((value, ctx) => {
  if (value.startOffset !== undefined && value.endOffset !== undefined && value.endOffset < value.startOffset) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['endOffset'], message: '锚点结束位置不能早于开始位置' });
  }
});
export type SourceAnchor = z.infer<typeof SourceAnchorSchema>;

export const ReadingContextSchema = z.object({
  url: ReadingUrlSchema,
  title: z.string().max(300).default('当前网页'),
  language: z.string().max(20).default('zh-CN'),
  scope: ReadingContextScopeSchema.default('selection'),
  body: z.string().min(1).max(256_000),
  section: z.string().max(80_000).optional(),
  selection: SourceAnchorSchema.optional(),
}).strict().superRefine((value, ctx) => {
  // A selection scoped request without an anchor would silently fall back to
  // the whole page in the BFF. Reject it at the shared boundary so the range
  // displayed by the plugin always matches the text sent to the model.
  if (value.scope === 'selection' && !value.selection) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['selection'],
      message: '选段范围需要提供原文锚点',
    });
  }
});
export type ReadingContext = z.infer<typeof ReadingContextSchema>;

export const ReadingAnswerInputSchema = z.object({
  action: ReadingActionSchema,
  context: ReadingContextSchema,
  prompt: z.string().max(4_000).optional(),
  history: z.array(z.object({ role: z.enum(['user', 'assistant']), content: z.string().max(8_000) }).strict()).max(20).default([]),
}).strict().superRefine((value, ctx) => {
  if (value.action === 'ask' && !value.prompt?.trim()) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['prompt'], message: '追问需要输入问题' });
  }
});
export type ReadingAnswerInput = z.infer<typeof ReadingAnswerInputSchema>;

export const ReadingTranslateInputSchema = z.object({
  url: ReadingUrlSchema,
  title: z.string().max(300).default('当前网页'),
  language: z.string().max(20).default('zh-CN'),
  blocks: z.array(z.object({ id: z.string().min(1).max(100), text: z.string().min(1).max(12_000) }).strict()).min(1).max(24),
}).strict();
export type ReadingTranslateInput = z.infer<typeof ReadingTranslateInputSchema>;

export const ReadingCitationSchema = z.object({
  quote: z.string().min(1).max(12_000),
  url: ReadingUrlSchema,
  anchor: SourceAnchorSchema.nullable().optional(),
}).strict();
export type ReadingCitation = z.infer<typeof ReadingCitationSchema>;

export const ReadingEvidenceSchema = z.object({
  quote: z.string().min(1).max(12_000),
  claim: z.string().max(4_000).default(''),
  anchor: SourceAnchorSchema.optional(),
}).strict();
export type ReadingEvidence = z.infer<typeof ReadingEvidenceSchema>;

export const ReadingAnswerSchema = z.object({
  answer: z.string().max(20_000),
  background: z.string().max(12_000).default(''),
  inference: z.string().max(12_000).default(''),
  limitations: z.array(z.string().max(2_000)).max(8).default([]),
  evidence: z.array(ReadingEvidenceSchema).max(8).default([]),
  citations: z.array(ReadingCitationSchema).max(24).default([]),
  warnings: z.array(z.string().max(2_000)).max(20).default([]),
  structured: z.boolean().default(false),
}).strict();
export type ReadingAnswer = z.infer<typeof ReadingAnswerSchema>;

/** Response shape shared by synchronous and streaming reading adapters. */
export const ReadingResultSchema = z.object({
  operation: ReadingActionSchema,
  original: z.string(),
  suggestion: z.string().nullable().optional(),
  reading: ReadingAnswerSchema.nullable().optional(),
  citations: z.array(ReadingCitationSchema).max(24).default([]),
  warnings: z.array(z.string()).max(20).default([]),
  truncated: z.boolean().default(false),
}).strict();
export type ReadingResult = z.infer<typeof ReadingResultSchema>;

export const ReadingSaveInputSchema = z.object({
  url: ReadingUrlSchema,
  title: z.string().trim().min(1).max(300),
  quote: z.string().trim().min(1).max(12_000),
  note: z.string().max(8_000).default(''),
  aiAnswer: z.string().max(20_000).optional(),
  anchor: SourceAnchorSchema.optional(),
  tags: z.array(z.string().trim().min(1).max(40)).max(10).default([]),
  // The browser keeps this key stable while a save is being retried. It is
  // optional for older clients; the BFF generates a key when absent.
  idempotencyKey: z.string().uuid().optional(),
}).strict();
export type ReadingSaveInput = z.infer<typeof ReadingSaveInputSchema>;

// Independent browser-reader contracts. These are local-first records; the
// API key is intentionally not part of any server-bound schema.
export const ProviderConfigSchema = z.object({
  baseUrl: z.string().url().refine((value) => /^https?:\/\//u.test(value), '模型地址必须使用 HTTP(S)'),
  model: z.string().trim().min(1).max(160),
  visionModel: z.string().trim().min(1).max(160),
  language: z.string().trim().min(2).max(20),
}).strict();
export type ProviderConfig = z.infer<typeof ProviderConfigSchema>;

export const ImageTextRegionSchema = z.object({
  text: z.string().max(4_000),
  translation: z.string().max(4_000),
  x: z.number().min(0),
  y: z.number().min(0),
  width: z.number().positive(),
  height: z.number().positive(),
}).strict();
export type ImageTextRegion = z.infer<typeof ImageTextRegionSchema>;

export const ReadingDocumentSchema = z.object({
  url: ReadingUrlSchema,
  title: z.string().max(300),
  version: z.string().max(128).nullable().optional(),
}).strict();
export type ReadingDocument = z.infer<typeof ReadingDocumentSchema>;

export const TranslationJobSchema = z.object({
  id: z.string().min(1).max(160),
  documentUrl: ReadingUrlSchema,
  contentHash: z.string().regex(/^[a-f0-9]{64}$/u).nullable().optional(),
  kind: z.enum(['text', 'image']),
  status: z.enum(['queued', 'running', 'completed', 'completed_with_errors', 'failed', 'cancelled', 'stale']),
  textDone: z.number().int().nonnegative().optional(),
  textTotal: z.number().int().nonnegative().optional(),
  imageDone: z.number().int().nonnegative().optional(),
  imageTotal: z.number().int().nonnegative().optional(),
  failedItems: z.array(z.object({
    id: z.string().min(1).max(160),
    kind: z.enum(['text', 'image']),
    label: z.string().max(240).optional(),
    error: z.string().max(2_000),
  }).strict()).max(160).optional(),
  warnings: z.array(z.string().max(2_000)).max(20).optional(),
  workerManaged: z.boolean().optional(),
  tabId: z.number().int().nonnegative().optional(),
  updatedAt: z.string().datetime().optional(),
  completedAt: z.string().datetime().optional(),
  error: z.string().max(2_000).optional(),
}).strict();
export type TranslationJob = z.infer<typeof TranslationJobSchema>;

export const SavedInsightSchema = z.object({
  id: z.string().min(1).max(160),
  document: ReadingDocumentSchema,
  quote: z.string().max(12_000),
  note: z.string().max(8_000),
  aiAnswer: z.string().max(20_000).optional(),
  tags: z.array(z.string().trim().min(1).max(40)).max(10).default([]),
  anchor: SourceAnchorSchema.optional(),
  createdAt: z.string().datetime(),
}).strict();
export type SavedInsight = z.infer<typeof SavedInsightSchema>;

/**
 * A local-first annotation attached to an exact source anchor.
 *
 * An annotation is separate from a saved insight: it is a private reading
 * mark/note and may be deleted without becoming a reusable knowledge item.
 */
export const AnnotationSchema = z.object({
  id: z.string().min(1).max(160),
  document: ReadingDocumentSchema,
  anchor: SourceAnchorSchema,
  note: z.string().max(8_000).default(''),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime().optional(),
}).strict();
export type Annotation = z.infer<typeof AnnotationSchema>;

/**
 * Explicitly synchronized reading state. The browser keeps this state local
 * by default; when a user asks to sync, only bounded discussion metadata and
 * anchors are sent. Full page text, translation cache and image bytes are
 * deliberately excluded from this contract.
 */
export const ReadingSessionStateSchema = z.object({
  radarSummaryId: z.string().uuid().nullable().optional(),
  selection: SourceAnchorSchema.nullable().optional(),
  answer: z.string().max(20_000).default(''),
  answerStructured: ReadingAnswerSchema.nullable().optional(),
  discussion: z.array(z.object({
    role: z.enum(['user', 'assistant']),
    content: z.string().max(8_000),
  }).strict()).max(20).default([]),
  discussionScope: z.enum(['selection', 'page', 'image']).default('selection'),
  image: z.object({
    id: z.string().max(160),
    src: z.string().url().max(2048).optional().or(z.literal('')),
    alt: z.string().max(2_000).default(''),
    width: z.number().finite().nonnegative().max(20_000).default(0),
    height: z.number().finite().nonnegative().max(20_000).default(0),
  }).strict().nullable().optional(),
  scrollY: z.number().finite().nonnegative().max(100_000_000).default(0),
  scrollHeight: z.number().finite().nonnegative().max(100_000_000).default(0),
}).strict();
export type ReadingSessionState = z.infer<typeof ReadingSessionStateSchema>;

export const ReadingSessionSyncInputSchema = z.object({
  clientId: z.string().uuid(),
  idempotencyKey: z.string().uuid(),
  document: ReadingDocumentSchema,
  state: ReadingSessionStateSchema,
}).strict();
export type ReadingSessionSyncInput = z.infer<typeof ReadingSessionSyncInputSchema>;

export const ReadingSessionSchema = ReadingSessionSyncInputSchema.extend({
  updatedAt: z.string().datetime(),
}).strict();
export type ReadingSession = z.infer<typeof ReadingSessionSchema>;
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

/**
 * Decision research is not complete when every option has merely been
 * mentioned. These are the default cells a decision run must account for.
 * They deliberately include operational measurements because those are the
 * gaps most likely to make a long report look more certain than it is.
 */
export const DEFAULT_RESEARCH_DECISION_DIMENSIONS = [
  '效果与适用范围',
  '成本与资源',
  '网络/性能实测',
  '磁盘与资源占用',
  '部署与构建',
  '回滚与恢复',
  '可运维性',
  '安全与风险',
] as const;

export const ResearchBriefSchema = z.object({
  objective: ResearchObjectiveSchema,
  question: z.string().min(2).max(2000),
  scope: ResearchScopeSchema,
  constraints: z.array(z.string().min(1).max(240)).max(20).default([]),
  questionsToAnswer: z.array(z.string().min(1).max(240)).max(20).default([]),
  comparisonOptions: z.array(z.string().min(1).max(240)).max(20).default([]),
  decisionDimensions: z.array(z.string().min(1).max(160)).max(20)
    .default([...DEFAULT_RESEARCH_DECISION_DIMENSIONS]),
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
