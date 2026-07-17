import { z } from 'zod';
import { SUMMARY_STATUS, CREATION_METHOD, SOURCE_POLICY, PROMOTE_STATUS } from './states.js';

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
export const CreateAiJobInput = z.object({
  topic: z.string().min(2).max(200),
  context: z.string().max(2000).optional(),                    // 用户手填上下文
  reportType: z.enum(['research_report', 'summary_brief']).default('research_report'),
  sourcePolicy: z.enum([SOURCE_POLICY.PREFER_USER_SOURCES, SOURCE_POLICY.ONLY_USER_SOURCES])
    .default(SOURCE_POLICY.PREFER_USER_SOURCES),
  sourceRefs: z.array(z.discriminatedUnion('type', [
    SourceRefUrl,
    SourceRefUuid('favorite'),
    SourceRefUuid('research'),
    SourceRefUuid('summary'),
  ])).max(10).default([]),
  idempotencyKey: z.string().uuid().optional(),
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

/** 评论提名（架构 §十四 §2） */
export const NominateCommentInput = z.object({
  commentId: z.string().uuid(),
});
export type NominateCommentInput = z.infer<typeof NominateCommentInput>;

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
