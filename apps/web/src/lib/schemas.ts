// 本地 BFF Zod schemas —— W3 沉淀 CRUD + 文件导入。
//
// 契约说明：这些 schema 应该加到 packages/shared/src/schemas.ts（来自
// docs/contracts/api-schemas.md §"Zod Schema 索引"），但 W3 工程师 A 不能改
// shared/ 包。本地定义后，在 PR 摘要里标记为需要主会话同步到 shared/。
//
// 命名与数据库字段对齐（Research / ContentImportJob）。

import { z } from 'zod';
import { RESEARCH_TYPE, CREATION_METHOD } from '@deep-research/shared/states';

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
  creationMethod: z
    .enum([
      CREATION_METHOD.MANUAL,
      CREATION_METHOD.AI_RESEARCH,
      CREATION_METHOD.FILE_IMPORT,
      CREATION_METHOD.CONFLUENCE_IMPORT,
    ])
    .default(CREATION_METHOD.MANUAL),
});
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
