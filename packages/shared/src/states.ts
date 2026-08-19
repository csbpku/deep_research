// 业务状态机枚举。与 docs/contracts/state-machines.md 严格一致。

// ai_research_jobs.status
export const AI_JOB_STATUS = {
  QUEUED: 'queued',
  RUNNING: 'running',
  PARTIAL: 'partial',
  SUCCEEDED: 'succeeded',
  FAILED: 'failed',
  CANCELLED: 'cancelled',
} as const;
export type AiJobStatus = (typeof AI_JOB_STATUS)[keyof typeof AI_JOB_STATUS];

// ai_research_jobs.current_step（架构 §十三 §3）
export const AI_JOB_STEP = {
  PLAN: 'plan',
  SEARCH: 'search',
  COMPRESS: 'compress',
  ANALYZE: 'analyze',
  WRITE: 'write',
} as const;
export type AiJobStep = (typeof AI_JOB_STEP)[keyof typeof AI_JOB_STEP];

// content_import_jobs.status（架构 §四点七）
export const IMPORT_STATUS = {
  QUEUED: 'queued',
  RUNNING: 'running',
  SUCCEEDED: 'succeeded',
  FAILED: 'failed',
  CANCELLED: 'cancelled',
} as const;
export type ImportStatus = (typeof IMPORT_STATUS)[keyof typeof IMPORT_STATUS];

// summaries.status（架构 §五 + §四点七）
export const SUMMARY_STATUS = {
  CANDIDATE: 'candidate',
  PENDING_REVIEW: 'pending_review',
  PUBLISHED: 'published',
  REJECTED: 'rejected',
  ARCHIVED: 'archived',
} as const;
export type SummaryStatus = (typeof SUMMARY_STATUS)[keyof typeof SUMMARY_STATUS];

// researches.status（架构 §十二）
export const RESEARCH_STATUS = {
  DRAFT: 'draft',
  PUBLISHED: 'published',
  ARCHIVED: 'archived',
} as const;
export type ResearchStatus = (typeof RESEARCH_STATUS)[keyof typeof RESEARCH_STATUS];

// researches.type
export const RESEARCH_TYPE = {
  RESEARCH: 'research',
  KNOWLEDGE: 'knowledge',
} as const;
export type ResearchType = (typeof RESEARCH_TYPE)[keyof typeof RESEARCH_TYPE];

// researches.creation_method（架构 §五 + §四点七）
export const CREATION_METHOD = {
  MANUAL: 'manual',
  AI_RESEARCH: 'ai_research',
  FILE_IMPORT: 'file_import',
  CONFLUENCE_IMPORT: 'confluence_import',
} as const;
export type CreationMethod = (typeof CREATION_METHOD)[keyof typeof CREATION_METHOD];

// comments.promote_status（架构 §十四 + §十七）
export const PROMOTE_STATUS = {
  NONE: 'none',
  NOMINATED: 'nominated',
  APPROVED: 'approved',
  REJECTED: 'rejected',
} as const;
export type PromoteStatus = (typeof PROMOTE_STATUS)[keyof typeof PROMOTE_STATUS];

// AI 调研 source policy（架构 §四点五 + §九 风险 5b）
export const SOURCE_POLICY = {
  PREFER_USER_SOURCES: 'prefer_user_sources',
  ONLY_USER_SOURCES: 'only_user_sources',
} as const;
export type SourcePolicy = (typeof SOURCE_POLICY)[keyof typeof SOURCE_POLICY];

// 用户角色
export const USER_ROLE = {
  MEMBER: 'member',
  ADMIN: 'admin',
} as const;
export type UserRole = (typeof USER_ROLE)[keyof typeof USER_ROLE];

// Week 5 雷达：radar_sync_runs.status
export const RADAR_SYNC_STATUS = {
  RUNNING: 'running',
  COMPLETED: 'completed',
  PARTIAL: 'partial',
  FAILED: 'failed',
} as const;
export type RadarSyncStatus = (typeof RADAR_SYNC_STATUS)[keyof typeof RADAR_SYNC_STATUS];

// Week 5 雷达：radar_feedback.feedbackType
export const RADAR_FEEDBACK_TYPE = {
  USEFUL: 'useful',
  INACCURATE: 'inaccurate',
  USED: 'used',
  FAVORITE: 'favorite',
  SUGGEST_RESEARCH: 'suggest_research',
} as const;
export type RadarFeedbackType = (typeof RADAR_FEEDBACK_TYPE)[keyof typeof RADAR_FEEDBACK_TYPE];

// Week 5 雷达：候选处理状态（同步批次内）
export const RADAR_CANDIDATE_STATUS = {
  NEW: 'new',
  INTERPRETED: 'interpreted',
  SKIPPED: 'skipped',
  FAILED: 'failed',
} as const;
export type RadarCandidateStatus = (typeof RADAR_CANDIDATE_STATUS)[keyof typeof RADAR_CANDIDATE_STATUS];

// Week 6：AI 多轮追问会话状态（架构 §六点一）
export const AI_CHAT_SESSION_STATUS = {
  ACTIVE: 'active',
  CLOSED: 'closed',
} as const;
export type AiChatSessionStatus =
  (typeof AI_CHAT_SESSION_STATUS)[keyof typeof AI_CHAT_SESSION_STATUS];

// Week 6：AI 多轮追问消息角色（架构 §六点一）
export const AI_CHAT_ROLE = {
  USER: 'user',
  ASSISTANT: 'assistant',
} as const;
export type AiChatRole = (typeof AI_CHAT_ROLE)[keyof typeof AI_CHAT_ROLE];

// ADR 0010: 研究目标 / 报告类型 / 综述状态

export const RESEARCH_OBJECTIVE = {
  EXPLORE: 'explore',
  LEARN: 'learn',
  INVESTIGATE: 'investigate',
  DECIDE: 'decide',
} as const;
export type ResearchObjective =
  (typeof RESEARCH_OBJECTIVE)[keyof typeof RESEARCH_OBJECTIVE];

export const RESEARCH_OUTPUT_TYPE = {
  MARKDOWN: 'markdown',
  SLIDES: 'slides',
} as const;
export type ResearchOutputType =
  (typeof RESEARCH_OUTPUT_TYPE)[keyof typeof RESEARCH_OUTPUT_TYPE];

export const TOPIC_ISSUE_KIND = {
  EVENT: 'event',
  PROBLEM: 'problem',
} as const;
export type TopicIssueKind =
  (typeof TOPIC_ISSUE_KIND)[keyof typeof TOPIC_ISSUE_KIND];

export const TOPIC_ISSUE_STATUS = {
  ACTIVE: 'active',
  RESOLVED: 'resolved',
  ARCHIVED: 'archived',
} as const;
export type TopicIssueStatus =
  (typeof TOPIC_ISSUE_STATUS)[keyof typeof TOPIC_ISSUE_STATUS];

export const RESEARCH_TOPIC_RELATION = {
  AUTO: 'auto',
  MANUAL: 'manual',
} as const;
export type ResearchTopicRelation =
  (typeof RESEARCH_TOPIC_RELATION)[keyof typeof RESEARCH_TOPIC_RELATION];

// ADR 0010: 专题列表筛选
export const TOPIC_LIST_FILTER = {
  ALL: 'all',
  HOT: 'hot',
  WARMING: 'warming',
  EMERGING: 'emerging',
  FOLLOWED: 'followed',
} as const;
export type TopicListFilter =
  (typeof TOPIC_LIST_FILTER)[keyof typeof TOPIC_LIST_FILTER];
