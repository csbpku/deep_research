// P1-C: per-user preferences (Zod schema + helpers).
//
// 设计：JsonB 列里只允许这 4 个键；其他 key 写入时由 zod 拒绝，
// 避免"未知字段污染"导致跨版本读不出。
import { z } from 'zod';

export const userPreferencesSchema = z
  .object({
    defaultReportType: z.enum(['research_report', 'summary_brief']).optional(),
    defaultSourcePolicy: z
      .enum(['prefer_user_sources', 'only_user_sources', 'web_only'])
      .optional(),
    timezone: z.string().min(1).max(64).optional(),
    notifyPrefs: z
      .object({
        commentReply: z.boolean().optional(),
        shareApproved: z.boolean().optional(),
        topicDigest: z.boolean().optional(),
      })
      .strict()
      .optional(),
  })
  .strict();

export type UserPreferences = z.infer<typeof userPreferencesSchema>;
