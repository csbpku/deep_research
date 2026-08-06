import { Prisma } from '@prisma/client';
import { RESEARCH_STATUS } from '@deep-research/shared/states';

export function researchListWhere(
  scope: 'published' | 'draft' | 'mine', userId: string,
  type?: 'research' | 'knowledge', query?: string,
): Prisma.ResearchWhereInput {
  return {
    AND: [
      ...(type ? [{ type: { equals: type as Prisma.EnumResearchTypeFilter['equals'] } }] : []),
      scope === 'draft'
        ? { authorId: userId, status: { equals: 'draft' as const } }
        : scope === 'mine'
          ? {
              authorId: userId,
              status: {
                in: [RESEARCH_STATUS.PUBLISHED, RESEARCH_STATUS.ARCHIVED],
              },
            }
          : { status: { equals: RESEARCH_STATUS.PUBLISHED as Prisma.EnumResearchStatusFilter['equals'] } },
      ...(query ? [{ OR: [
        { title: { contains: query, mode: 'insensitive' as Prisma.QueryMode } },
        { body: { contains: query, mode: 'insensitive' as Prisma.QueryMode } },
        { tags: { has: query } },
      ] }] : []),
    ],
  };
}
