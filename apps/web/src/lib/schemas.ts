// 本地 BFF Zod schemas —— W3 沉淀 CRUD + 文件导入。
//
// 契约说明：这些 schema 应该加到 packages/shared/src/schemas.ts（来自
// docs/contracts/api-schemas.md §"Zod Schema 索引"），但 W3 工程师 A 不能改
// shared/ 包。本地定义后，在 PR 摘要里标记为需要主会话同步到 shared/。
//
// 命名与数据库字段对齐（Research / ContentImportJob）。

import { z } from 'zod';
import { RESEARCH_TYPE, CREATION_METHOD, RADAR_FEEDBACK_TYPE } from '@deep-research/shared/states';

// ──────────────────────────────────────────────────────────────────────
// Research CRUD
// ──────────────────────────────────────────────────────────────────────

/** 创建沉淀草稿 */
export const CreateResearchInput = z.object({
  title: z.string().min(1).max(300),
  body: z.string().min(1).max(50000),
  type: z.enum([RESEARCH_TYPE.RESEARCH, RESEARCH_TYPE.KNOWLEDGE]).default(RESEARCH_TYPE.RESEARCH),
  background: z.string().max(2000).optional(),
  conclusion: z.string().max(2000).optional(),
  risks: z.string().max(2000).optional(),
  tags: z.array(z.string().min(1).max(40)).max(10).default([]),
}).strict(); // 拒绝客户端传 creationMethod（服务端写死 'manual'）
export type CreateResearchInput = z.infer<typeof CreateResearchInput>;

/** 编辑沉淀 */
export const UpdateResearchInput = z.object({
  title: z.string().min(1).max(300).optional(),
  body: z.string().min(1).max(50000).optional(),
  background: z.string().max(2000).nullable().optional(),
  conclusion: z.string().max(2000).nullable().optional(),
  risks: z.string().max(2000).nullable().optional(),
  tags: z.array(z.string().min(1).max(40)).max(10).optional(),
});
export type UpdateResearchInput = z.infer<typeof UpdateResearchInput>;

/** 查询沉淀列表 */
export const ResearchListQuery = z.object({
  type: z.enum([RESEARCH_TYPE.RESEARCH, RESEARCH_TYPE.KNOWLEDGE]).optional(),
  scope: z.enum(['published', 'draft']).default('published'),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(50).default(20),
});
export type ResearchListQuery = z.infer<typeof ResearchListQuery>;

// ──────────────────────────────────────────────────────────────────────
// File Import
// ──────────────────────────────────────────────────────────────────────

/** 文件导入元数据（与 shared CreateFileImportInput 对齐，增加 fileContent 用于 BFF 校验） */
export const CreateImportInput = z.object({
  filename: z.string().min(1).max(255),
  mimeType: z.enum(['text/markdown', 'text/plain', 'text/html']),
  sizeBytes: z.number().int().positive().max(5 * 1024 * 1024),
});
export type CreateImportInput = z.infer<typeof CreateImportInput>;

// ──────────────────────────────────────────────────────────────────────
// Search
// ──────────────────────────────────────────────────────────────────────

/**
 * 全文搜索查询参数（GET /api/search）。
 * - q: 必填，1-200 字符（trim 后空字符串视为过短）
 * - type: 可选，不传=全部
 * - page/per_page: 分页；per_page 上限 50
 *
 * 契约源：docs/agent-prompts/week4-engineer-a.md §任务 2
 * 注：摘要/长文/精华来自 published-only search_docs；雷达候选动态查询 summaries。
 */
export const SearchDocType = {
  SUMMARY: 'summary',
  LONG_RESEARCH: 'long_research',
  KNOWLEDGE: 'knowledge',
  RADAR: 'radar',
} as const;

export const SearchQuery = z.object({
  q: z
    .string()
    .trim()
    .min(1, '搜索关键词不能为空')
    .max(200, '搜索关键词不能超过 200 字符'),
  type: z
    .enum([
      SearchDocType.SUMMARY,
      SearchDocType.LONG_RESEARCH,
      SearchDocType.KNOWLEDGE,
      SearchDocType.RADAR,
    ])
    .optional(),
  page: z.coerce.number().int().min(1).default(1),
  per_page: z.coerce.number().int().min(1).max(50).default(20),
});
export type SearchQuery = z.infer<typeof SearchQuery>;

// ──────────────────────────────────────────────────────────────────────
// Week 5 雷达 (Radar) —— 列表 / 详情 / 反馈 / Admin 操作
// ──────────────────────────────────────────────────────────────────────

/** 雷达候选状态过滤（schema 校验 shared/SUMMARY_STATUS 子集） */
export const RADAR_STATUS_VALUES = [
  'candidate',
  'pending_review',
  'published',
  'rejected',
  'archived',
] as const;

/** /api/radar 列表查询参数 */
export const RadarListQuery = z.object({
  q: z.string().trim().max(200).optional(),
  sourceType: z.string().trim().min(1).max(32).optional(),
  status: z.enum(RADAR_STATUS_VALUES).optional(),
  quality: z.enum(['relevant', 'all']).default('relevant'),
  page: z.coerce.number().int().min(1).default(1),
  per_page: z.coerce.number().int().min(1).max(50).default(20),
});
export type RadarListQuery = z.infer<typeof RadarListQuery>;

/** /api/radar/[id] 路径参数 */
export const RadarIdParam = z.object({ id: z.string().uuid() });
export type RadarIdParam = z.infer<typeof RadarIdParam>;

/** /api/summaries/[id] 路径参数 */
export const SummaryIdParam = z.object({ id: z.string().uuid() });
export type SummaryIdParam = z.infer<typeof SummaryIdParam>;

/** /api/researches/[id] 路径参数 */
export const ResearchIdParam = z.object({ id: z.string().uuid() });
export type ResearchIdParam = z.infer<typeof ResearchIdParam>;

/** POST /api/radar-feedback 提交反馈 */
export const CreateRadarFeedbackInput = z.object({
  summaryId: z.string().uuid(),
  feedbackType: z.enum([
    RADAR_FEEDBACK_TYPE.USEFUL,
    RADAR_FEEDBACK_TYPE.INACCURATE,
    RADAR_FEEDBACK_TYPE.USED,
    RADAR_FEEDBACK_TYPE.FAVORITE,
    RADAR_FEEDBACK_TYPE.SUGGEST_RESEARCH,
  ]),
});
export type CreateRadarFeedbackInput = z.infer<typeof CreateRadarFeedbackInput>;

/** DELETE /api/radar-feedback 查询参数 */
export const DeleteRadarFeedbackQuery = z.object({
  summaryId: z.string().uuid(),
  feedbackType: z.enum([
    RADAR_FEEDBACK_TYPE.USEFUL,
    RADAR_FEEDBACK_TYPE.INACCURATE,
    RADAR_FEEDBACK_TYPE.USED,
    RADAR_FEEDBACK_TYPE.FAVORITE,
    RADAR_FEEDBACK_TYPE.SUGGEST_RESEARCH,
  ]),
});
export type DeleteRadarFeedbackQuery = z.infer<typeof DeleteRadarFeedbackQuery>;

/** POST /api/admin/radar/[id]/select 选入每日摘要 */
export const AdminRadarSelectInput = z.object({
  summaryDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/u, 'summaryDate must be YYYY-MM-DD'),
  sortOrder: z.number().int().min(1).max(4),
  selectionReason: z.string().trim().min(2).max(500),
});
export type AdminRadarSelectInput = z.infer<typeof AdminRadarSelectInput>;

// ──────────────────────────────────────────────────────────────────────
// Week 8 评论 (Comments)
// ──────────────────────────────────────────────────────────────────────

/** 评论目标类型：summary / research，恰好一个非空（由 schema CHECK 保证） */
export const COMMENT_TARGET_VALUES = ['summary', 'research'] as const;

/** POST /api/summaries/[date]/comments 或 /api/researches/[id]/comments */
export const CreateCommentInput = z.object({
  body: z.string().trim().min(1).max(2000),
  parentId: z.string().uuid().optional(),
});
export type CreateCommentInput = z.infer<typeof CreateCommentInput>;

/** 评论列表查询 */
export const CommentListQuery = z.object({
  page: z.coerce.number().int().min(1).default(1),
  per_page: z.coerce.number().int().min(1).max(50).default(20),
  sort: z.enum(['newest', 'oldest']).default('newest'),
});
export type CommentListQuery = z.infer<typeof CommentListQuery>;

/** 评论 ID 路径参数 */
export const CommentIdParam = z.object({ id: z.string().uuid() });
export type CommentIdParam = z.infer<typeof CommentIdParam>;

/** POST /api/admin/comments/[id]/promote —— Admin 从评论提炼成精华 */
export const AdminCommentPromoteInput = z.object({
  /** 提炼后的精华标题 */
  title: z.string().trim().min(2).max(300),
  /** 提炼后的精华正文 */
  body: z.string().trim().min(1).max(50000),
  /** 可选覆盖结论 */
  conclusion: z.string().trim().max(2000).optional(),
  /** 可选标签 */
  tags: z.array(z.string().min(1).max(40)).max(10).default([]),
});
export type AdminCommentPromoteInput = z.infer<typeof AdminCommentPromoteInput>;

/** POST /api/admin/comments/[id]/dismiss —— Admin 拒绝评论提名 */
export const AdminCommentDismissInput = z.object({
  reason: z.string().trim().min(2).max(500),
});
export type AdminCommentDismissInput = z.infer<typeof AdminCommentDismissInput>;

/** GET /api/admin/shares —— 分享审核列表 */
export const AdminShareListQuery = z.object({
  status: z.enum(['pending', 'approved', 'rejected']).default('pending'),
  page: z.coerce.number().int().min(1).default(1),
  per_page: z.coerce.number().int().min(1).max(50).default(20),
});
export type AdminShareListQuery = z.infer<typeof AdminShareListQuery>;

/** POST /api/admin/shares/[id]/review —— 批准/拒绝分享 */
export const AdminShareReviewInput = z
  .object({
    action: z.enum(['approve', 'reject']),
    reason: z.string().trim().min(2).max(500).optional(),
  })
  .strict();
export type AdminShareReviewInput = z.infer<typeof AdminShareReviewInput>;

/** GET /api/admin/comments —— 评论提名列表 */
export const AdminCommentListQuery = z.object({
  status: z.enum(['pending', 'approved', 'rejected', 'all']).default('pending'),
  page: z.coerce.number().int().min(1).default(1),
  per_page: z.coerce.number().int().min(1).max(50).default(20),
});
export type AdminCommentListQuery = z.infer<typeof AdminCommentListQuery>;

/** GET /api/admin/dashboard —— Admin 首页统计 */
export const AdminDashboardQuery = z.object({});
export type AdminDashboardQuery = z.infer<typeof AdminDashboardQuery>;
