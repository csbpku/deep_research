// Prisma client singleton.
//
// 共享契约 apps/web/prisma/schema.prisma 已 freeze（commit a18676e）。
// 本文件只允许引用 Prisma client 类型，不修改 schema / 不创建 migration。
//
// 单元测试不依赖 DB；测试代码请勿 import 此文件。

import { PrismaClient } from '@prisma/client';

declare global {
  // eslint-disable-next-line no-var
  var __deepResearchPrisma: PrismaClient | undefined;
}

/**
 * Prisma client 单例。
 *
 * Next.js dev 模式下，模块会因 HMR 反复重新加载 —— 若每次重新 new PrismaClient()，
 * 会持续涨连接数直到 PG `max_connections` 顶满。把 client 缓存到 globalThis 上，
 * 保证整个 dev 进程共用一个连接池。
 */
export const prisma: PrismaClient =
  globalThis.__deepResearchPrisma ??
  new PrismaClient({
    log: ['warn', 'error'],
  });

if (process.env.NODE_ENV !== 'production') {
  globalThis.__deepResearchPrisma = prisma;
}