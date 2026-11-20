-- P0-4 判断落点：在雷达反馈枚举上追加轻量判断类型。
-- Additive only：不重命名、不删除、不回填历史反馈。
ALTER TYPE "RadarFeedbackType" ADD VALUE IF NOT EXISTS 'read';
ALTER TYPE "RadarFeedbackType" ADD VALUE IF NOT EXISTS 'later';
ALTER TYPE "RadarFeedbackType" ADD VALUE IF NOT EXISTS 'pilot';
