import { Prisma } from '@prisma/client';
import { RESEARCH_STATUS } from '@deep-research/shared/states';

export interface ResearchListWhereInput {
  scope: 'published' | 'draft' | 'mine';
  userId: string;
  type?: 'research' | 'knowledge';
  query?: string;
  topicId?: string;
  objective?: 'explore' | 'learn' | 'investigate' | 'decide';
  reviewStatus?: string;
  hasOpenClaims?: boolean;
}

export function researchListWhere(input: ResearchListWhereInput): Prisma.ResearchWhereInput {
  const { scope, userId, type, query, topicId, objective, reviewStatus, hasOpenClaims } = input;
  const clauses: Prisma.ResearchWhereInput[] = [];
  if (type) {
    clauses.push({ type: { equals: type as Prisma.EnumResearchTypeFilter['equals'] } });
  }
  if (scope === 'draft') {
    clauses.push({ authorId: userId, status: { equals: 'draft' as const } });
  } else if (scope === 'mine') {
    clauses.push({
      authorId: userId,
      status: { in: [RESEARCH_STATUS.PUBLISHED, RESEARCH_STATUS.ARCHIVED] },
    });
  } else {
    clauses.push({
      status: { equals: RESEARCH_STATUS.PUBLISHED as Prisma.EnumResearchStatusFilter['equals'] },
    });
  }
  if (query) {
    clauses.push({
      OR: [
        { title: { contains: query, mode: 'insensitive' as Prisma.QueryMode } },
        { body: { contains: query, mode: 'insensitive' as Prisma.QueryMode } },
        // 标签是数组：`has` 是整值命中。界面文案按这个语义写，
        // 不承诺标签的部分匹配。
        { tags: { has: query } },
      ],
    });
  }
  if (topicId) {
    clauses.push({ researchTopics: { some: { topicId } } });
  }
  if (objective) {
    clauses.push({
      sourceAiJob: {
        objective,
        status: { in: ['succeeded', 'partial'] as Prisma.EnumAiJobStatusFilter['in'] },
      },
    });
  }
  if (reviewStatus) {
    clauses.push({ reviewStatus });
  }
  if (hasOpenClaims === true) {
    // has at least one review claim: reviewClaims is not null and not the empty JSON
    clauses.push({ NOT: { reviewClaims: { equals: Prisma.JsonNull } } });
    clauses.push({ NOT: { reviewClaims: { equals: [] } } });
  } else if (hasOpenClaims === false) {
    clauses.push({
      OR: [
        { reviewClaims: { equals: Prisma.JsonNull } },
        { reviewClaims: { equals: [] } },
      ],
    });
  }
  return { AND: clauses };
}

export function researchListWhereLegacy(
  scope: 'published' | 'draft' | 'mine', userId: string,
  type?: 'research' | 'knowledge', query?: string,
): Prisma.ResearchWhereInput {
  return researchListWhere({ scope, userId, type, query });
}

export type ResearchListSort = 'newest' | 'updated' | 'title';

/**
 * 研究库的排序在服务端执行：客户端只能重排当前页，那会让"最近编辑"
 * 看起来像全库顺序。精选条目只在"最新发布"下置顶，其余排序按用户选定的
 * 字段排，最后用 id 兜底保证分页稳定。
 */
export function researchListOrderBy(
  sort: ResearchListSort,
): Prisma.ResearchOrderByWithRelationInput[] {
  if (sort === 'updated') {
    return [{ updatedAt: 'desc' }, { featuredAt: { sort: 'desc', nulls: 'last' } }, { id: 'desc' }];
  }
  if (sort === 'title') {
    return [{ title: 'asc' }, { id: 'desc' }];
  }
  return [
    { featuredAt: { sort: 'desc', nulls: 'last' } },
    { publishedAt: { sort: 'desc', nulls: 'last' } },
    { createdAt: 'desc' },
    { id: 'desc' },
  ];
}
