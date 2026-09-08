// /topics/[slug] — 专题详情（ADR 0010）
//
// server-side：抓取专题元数据、热点议题、相关研究与候选；
// 然后把序列化数据交给客户端组件 TopicDetailTabs 渲染 4 标签视图。
import { notFound } from 'next/navigation';

import { prisma } from '@/lib/db';
import { getCurrentUser } from '@/lib/auth/session';
import { collapseTopicIssues, findTopicBySlugOrId, loadTopicCandidateTrend } from '@/lib/topics';
import { TopicDetailTabs, type SynthesisPayloadV2 } from './TopicDetailTabs';

export const dynamic = 'force-dynamic';

export default async function TopicDetailPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const user = await getCurrentUser();
  const topic = await findTopicBySlugOrId(slug, {
    id: true,
    slug: true,
    name: true,
    summary: true,
    tier: true,
    aggregationWindowStart: true,
    aggregationWindowEnd: true,
    candidateCount: true,
    sourceCount: true,
    lastSyncedAt: true,
    synthesisPayload: true,
    synthesisErrorCode: true,
    synthesisErrorMessage: true,
    lastSynthesisSuccessAt: true,
  });
  if (!topic) notFound();

  const followedRow = user
    ? await prisma.topicFollow.findUnique({
        where: { userId_topicId: { userId: user.id, topicId: topic.id } },
        select: { id: true, lastViewedAt: true },
      })
    : null;
  const followed = !!followedRow;
  const activeIssueWhere = { topicId: topic.id, status: 'active' as const };

  const [
    issueRowsRaw,
    researchRows,
    candidateRows,
    candidateTrend,
  ] = await Promise.all([
    prisma.topicIssue.findMany({
      where: activeIssueWhere,
      orderBy: [{ importanceScore: 'desc' }, { lastSeenAt: 'desc' }, { id: 'asc' }],
      select: {
        id: true,
        title: true,
        proposition: true,
        kind: true,
        importanceScore: true,
        firstSeenAt: true,
        lastSeenAt: true,
        candidates: { select: { summaryId: true } },
      },
    }),
    prisma.researchTopic.findMany({
      where: { topicId: topic.id },
      orderBy: { createdAt: 'desc' },
      take: 12,
      select: {
        createdAt: true,
        research: {
          select: {
            id: true,
            title: true,
            status: true,
            type: true,
          },
        },
      },
    }),
    prisma.topicCandidate.findMany({
      where: { topicId: topic.id },
      orderBy: { addedAt: 'desc' },
      take: 80,
      include: {
        summary: {
          select: {
            id: true,
            title: true,
            url: true,
            originalKind: true,
            tags: true,
            interpretation: true,
            publishedAt: true,
          },
        },
      },
    }),
    loadTopicCandidateTrend(topic.id),
  ]);

  const issueRows = collapseTopicIssues(
    issueRowsRaw.map((issue) => ({
      id: issue.id,
      title: issue.title,
      proposition: issue.proposition,
      kind: issue.kind as 'event' | 'problem',
      importanceScore: issue.importanceScore,
      firstSeenAt: issue.firstSeenAt,
      lastSeenAt: issue.lastSeenAt,
      candidateIds: issue.candidates.map((candidate) => candidate.summaryId),
    })),
  );
  const issueTotalCount = issueRows.length;
  const issueUnreadCount = followedRow
    ? issueRows.filter((issue) => (
        !followedRow.lastViewedAt || issue.lastSeenAt > followedRow.lastViewedAt
      )).length
    : 0;

  // 只用公开展示的 issue 建立候选映射，避免重复生成记录再次污染来源分组。
  const issueCandidateMapByIssue = new Map<string, string[]>();
  const candidateToIssue = new Map<string, string>();
  for (const issue of issueRows) {
    issueCandidateMapByIssue.set(issue.id, [...issue.candidateIds]);
    for (const summaryId of issue.candidateIds) {
      candidateToIssue.set(summaryId, issue.id);
    }
  }

  return (
    <TopicDetailTabs
      topic={{
        id: topic.id,
        slug: topic.slug,
        name: topic.name,
        summary: topic.summary,
        tier: topic.tier,
        candidateCount: topic.candidateCount,
        sourceCount: topic.sourceCount,
        aggregationWindowStart: topic.aggregationWindowStart.toISOString(),
        aggregationWindowEnd: topic.aggregationWindowEnd.toISOString(),
        lastSyncedAt: topic.lastSyncedAt?.toISOString() ?? null,
        synthesisPayload: (topic.synthesisPayload ?? null) as SynthesisPayloadV2 | null,
        synthesisErrorCode: topic.synthesisErrorCode ?? null,
        synthesisErrorMessage: topic.synthesisErrorMessage ?? null,
        lastSynthesisSuccessAt: topic.lastSynthesisSuccessAt?.toISOString() ?? null,
        candidateTrend,
      }}
      issues={issueRows.slice(0, 12).map((issue) => ({
        id: issue.id,
        title: issue.title,
        proposition: issue.proposition,
        kind: issue.kind,
        importanceScore: issue.importanceScore,
        firstSeenAt: issue.firstSeenAt.toISOString(),
        lastSeenAt: issue.lastSeenAt.toISOString(),
        candidateIds: issueCandidateMapByIssue.get(issue.id) ?? [],
      }))}
      sourceIssues={issueRows.map((issue) => ({ id: issue.id, title: issue.title }))}
      researchTopics={researchRows.map((row) => ({
        researchId: row.research.id,
        researchTitle: row.research.title,
        researchStatus: row.research.status,
        researchType: row.research.type,
        createdAt: row.createdAt.toISOString(),
      }))}
      candidates={candidateRows.map((c) => ({
        summaryId: c.summary.id,
        title: c.summary.title,
        url: c.summary.url,
        originalKind: c.summary.originalKind ?? 'unknown',
        tags: c.summary.tags,
        interpretation: c.summary.interpretation,
        publishedAt: c.summary.publishedAt?.toISOString() ?? null,
        issueId: candidateToIssue.get(c.summary.id) ?? undefined,
      }))}
      issueTotalCount={issueTotalCount}
      issueUnreadCount={issueUnreadCount}
      followed={!!followed}
      isAuthenticated={!!user}
      isAdmin={user?.role === 'admin'}
    />
  );
}
