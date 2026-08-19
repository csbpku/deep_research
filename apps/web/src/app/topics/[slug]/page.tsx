// /topics/[slug] — 专题详情（ADR 0010）
//
// server-side：抓取专题元数据、热点议题、相关研究与候选；
// 然后把序列化数据交给客户端组件 TopicDetailTabs 渲染 4 标签视图。
import { notFound } from 'next/navigation';

import { prisma } from '@/lib/db';
import { getCurrentUser } from '@/lib/auth/session';
import { findTopicBySlugOrId } from '@/lib/topics';
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

  const followed = user
    ? await prisma.topicFollow.findUnique({
        where: { userId_topicId: { userId: user.id, topicId: topic.id } },
        select: { id: true },
      })
    : null;

  const [issuesRaw, researchRows, candidateRows, issueCandidateMap] = await Promise.all([
    prisma.topicIssue.findMany({
      where: { topicId: topic.id, status: 'active' },
      orderBy: [{ importanceScore: 'desc' }, { lastSeenAt: 'desc' }],
      take: 12,
      select: {
        id: true,
        title: true,
        proposition: true,
        kind: true,
        importanceScore: true,
        firstSeenAt: true,
        lastSeenAt: true,
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
      take: 30,
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
    prisma.topicIssueCandidate.findMany({
      where: { issue: { topicId: topic.id, status: 'active' } },
      select: { issueId: true, summaryId: true, addedAt: true },
    }),
  ]);

  // 候选 → issue 映射 + 每个 issue 的候选 id 列表
  const issueCandidateMapByIssue = new Map<string, string[]>();
  const candidateToIssue = new Map<string, string>();
  for (const row of issueCandidateMap) {
    const list = issueCandidateMapByIssue.get(row.issueId) ?? [];
    list.push(row.summaryId);
    issueCandidateMapByIssue.set(row.issueId, list);
    candidateToIssue.set(row.summaryId, row.issueId);
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
      }}
      issues={issuesRaw.map((issue) => ({
        id: issue.id,
        title: issue.title,
        proposition: issue.proposition,
        kind: issue.kind as 'event' | 'problem',
        importanceScore: issue.importanceScore,
        firstSeenAt: issue.firstSeenAt.toISOString(),
        lastSeenAt: issue.lastSeenAt.toISOString(),
        candidateIds: issueCandidateMapByIssue.get(issue.id) ?? [],
      }))}
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
      followed={!!followed}
      isAdmin={user?.role === 'admin'}
    />
  );
}
