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
