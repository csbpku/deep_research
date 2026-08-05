// BFF: GET /api/admin/topic-proposals — Admin 主题提议审核队列。
import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';

import { prisma } from '@/lib/db';
import { apiHandler } from '@/lib/api-handler';
import { requireAdmin } from '@/lib/auth/session';

export const GET = apiHandler<[NextRequest]>(async (req) => {
  const admin = await requireAdmin(req);
  if (admin instanceof NextResponse) return admin;
  const url = new URL(req.url);
  const status = url.searchParams.get('status') ?? 'proposed';
  const allowed = ['proposed', 'approved', 'rejected', 'expired'] as const;
  const resolvedStatus = allowed.includes(status as (typeof allowed)[number])
    ? (status as (typeof allowed)[number])
    : 'proposed';
  const proposals = await prisma.topicProposal.findMany({
    where: { status: resolvedStatus },
    orderBy: [{ confidence: 'desc' }, { createdAt: 'desc' }],
    take: 50,
    include: {
      candidates: {
        where: { included: true },
        orderBy: { fitScore: 'desc' },
        include: {
          summary: {
            select: {
              id: true,
              title: true,
              url: true,
              interpretation: true,
              tldr: true,
              repoSummary: true,
              arxivAnalysis: true,
              highlights: true,
              originalKind: true,
            },
          },
        },
      },
    },
  });
  return NextResponse.json({
    items: proposals.map((proposal) => ({
      ...proposal,
      windowStart: proposal.windowStart.toISOString(),
      windowEnd: proposal.windowEnd.toISOString(),
      createdAt: proposal.createdAt.toISOString(),
      reviewedAt: proposal.reviewedAt?.toISOString() ?? null,
      candidates: proposal.candidates.map((candidate) => ({
        ...candidate,
        createdAt: candidate.createdAt.toISOString(),
        updatedAt: candidate.updatedAt.toISOString(),
      })),
    })),
  });
});
