import { Prisma } from '@prisma/client';

import { prisma } from '@/lib/db';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** 动态路由可能拿到 URL 编码后的中文 slug，先把编码与解码两种形式都纳入查找。 */
export function topicLookupKeys(key: string): string[] {
  const keys = [key];
  if (key.includes('%')) {
    try {
      const decoded = decodeURIComponent(key);
      if (decoded !== key) keys.push(decoded);
    } catch {
      // 保留原始 key，交给数据库查询
    }
  }
  return keys;
}

/**
 * 主题详情按 slug 路由，但发布流程/后台可能只拿到 topic id。
 * 先按 slug 查，命中不了且参数是 UUID 时再按 id 查，避免 UUID 链接落到 404。
 */
export async function findTopicBySlugOrId<T extends Prisma.TopicSelect>(
  key: string,
  select: T,
): Promise<Prisma.TopicGetPayload<{ select: T }> | null> {
  for (const candidate of topicLookupKeys(key)) {
    const topic = await prisma.topic.findUnique({ where: { slug: candidate }, select });
    if (topic) return topic;
  }
  if (!UUID_RE.test(key)) return null;
  return prisma.topic.findUnique({ where: { id: key }, select });
}
