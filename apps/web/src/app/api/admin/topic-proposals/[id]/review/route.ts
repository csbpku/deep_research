// BFF: POST /api/admin/topic-proposals/[id]/review — 发布或驳回主题提议。
import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';

import { prisma } from '@/lib/db';
import { apiHandler, parseBody } from '@/lib/api-handler';
import { requireAdmin } from '@/lib/auth/session';
import { AdminTopicProposalReviewInput, SummaryIdParam } from '@/lib/schemas';

function topicSlug(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9一-鿿]+/gu, '-').replace(/^-|-$/gu, '').slice(0, 120);
}

function sourceKey(url: string, originalKind: string | null): string {
  try {
    const parsed = new URL(url);
    if (parsed.hostname.endsWith('github.com')) {
      const owner = parsed.pathname.split('/').filter(Boolean)[0];
      return owner ? `github:${owner.toLowerCase()}` : 'github';
    }
    return parsed.hostname.toLowerCase();
  } catch {
    return originalKind ?? 'unknown';
  }
}

export const POST = apiHandler<[NextRequest, { params: Promise<{ id: string }> }]>(async (req, ctx) => {
  const admin = await requireAdmin(req);
  if (admin instanceof NextResponse) return admin;
  const parsed = SummaryIdParam.safeParse(await ctx.params);
  if (!parsed.success) return NextResponse.json({ code: 'VALIDATION_FAILED', message: 'id 必须为 UUID' }, { status: 400 });
  const body = await parseBody(req, AdminTopicProposalReviewInput);
  if (body instanceof NextResponse) return body;

  const proposal = await prisma.topicProposal.findUnique({
    where: { id: parsed.data.id },
    include: {
      candidates: {
        where: { included: true },
        include: { summary: { select: { id: true, url: true, originalKind: true } } },
      },
    },
  });
  if (!proposal) return NextResponse.json({ code: 'NOT_FOUND', message: '主题提议不存在' }, { status: 404 });
  if (proposal.status !== 'proposed') return NextResponse.json({ code: 'VALIDATION_FAILED', message: '该提议已处理' }, { status: 409 });

  if (body.action === 'reject') {
    if (!body.reason) return NextResponse.json({ code: 'VALIDATION_FAILED', message: '驳回必须填写原因' }, { status: 400 });
    await prisma.topicProposal.update({
      where: { id: proposal.id },
      data: { status: 'rejected', reviewerId: admin.id, reviewReason: body.reason, reviewedAt: new Date() },
    });
    return NextResponse.json({ ok: true, action: 'reject' });
  }

  const selected = body.includedSummaryIds
    ? new Set(body.includedSummaryIds)
    : new Set(proposal.candidates.map((candidate) => candidate.summary.id));
  const candidates = proposal.candidates.filter((candidate) => selected.has(candidate.summary.id));
  const sourceCount = new Set(candidates.map((candidate) => sourceKey(candidate.summary.url, candidate.summary.originalKind))).size;
  if (candidates.length < 3 || sourceCount < 2) {
    return NextResponse.json({ code: 'VALIDATION_FAILED', message: '发布至少需要 3 条候选和 2 个独立发布方' }, { status: 400 });
  }

  const name = body.name ?? proposal.name;
  const proposition = body.proposition ?? proposal.proposition;
  const slug = topicSlug(name);
  if (!slug) return NextResponse.json({ code: 'VALIDATION_FAILED', message: '主题名称无法生成有效地址' }, { status: 400 });
  const now = new Date();
  const result = await prisma.$transaction(async (tx) => {
    const topic = await tx.topic.upsert({
      where: { slug },
      create: {
        slug,
        name,
        summary: proposition,
        tier: candidates.length >= 6 ? 'hot' : 'warming',
        candidateCount: candidates.length,
        sourceCount,
        aggregationWindowStart: proposal.windowStart,
        aggregationWindowEnd: proposal.windowEnd,
        lastSyncedAt: now,
      },
      update: {
        name,
        summary: proposition,
        candidateCount: candidates.length,
        sourceCount,
        aggregationWindowStart: proposal.windowStart,
        aggregationWindowEnd: proposal.windowEnd,
        lastSyncedAt: now,
      },
      select: { id: true, slug: true },
    });
    await tx.topicCandidate.createMany({
      data: candidates.map((candidate) => ({
        topicId: topic.id,
        summaryId: candidate.summary.id,
        similarityScore: candidate.fitScore,
        addedReason: 'auto' as const,
      })),
      skipDuplicates: true,
    });
    await tx.topicProposalCandidate.updateMany({
      where: { proposalId: proposal.id, summaryId: { notIn: candidates.map((candidate) => candidate.summary.id) } },
      data: { included: false, exclusionReason: 'Admin 审核时移除' },
    });
    await tx.topicProposal.update({
      where: { id: proposal.id },
      data: { status: 'approved', name, proposition, reviewerId: admin.id, reviewedAt: now, publishedTopicId: topic.id },
    });
    return topic;
  });
  return NextResponse.json({ ok: true, action: 'approve', topic: result });
});
