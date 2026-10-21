// /topics — 技术专题列表 (ADR 0010: 含变化摘要、未读议题、相关研究 + 筛选芯片)
import * as React from 'react';
import Link from 'next/link';
import { Sparkles, TrendingUp, Compass, BookOpenCheck, Bell } from 'lucide-react';
import Paper from '@mui/material/Paper';
import Chip from '@mui/material/Chip';

import { prisma } from '@/lib/db';
import { PageHeader } from '@/components/domain/PageHeader';
import { StatusBadge } from '@/components/domain/StatusBadge';
import { EmptyState } from '@/components/EmptyState';
import { getCurrentUser } from '@/lib/auth/session';
import { collapseTopicIssues } from '@/lib/topics';
import { TopicsFilter } from './TopicsFilter';
import { parseTopicFilter, type TopicFilterKey } from './topic-filter-options';
import styles from './topics.module.css';

type IconComponent = React.ComponentType<{ className?: string }>;

/** 主题 tier 的 icon 映射 —— 颜色统一由 StatusBadge kind="topicTier" 接管 */
const TIER_ICONS: Record<string, IconComponent> = {
  hot: TrendingUp,
  warming: Sparkles,
  emerging: Compass,
};

export const dynamic = 'force-dynamic';

export default async function TopicsPage({ searchParams }: { searchParams: Promise<{ filter?: string }> }) {
  const sp = await searchParams;
  const filter = parseTopicFilter(sp.filter);
  const user = await getCurrentUser();
  const anonymousFollowedFilter = filter === 'followed' && !user;

  const tierFilter = filter === 'hot' || filter === 'warming' || filter === 'emerging'
    ? { tier: filter }
    : {};
  const followedFilter = filter === 'followed' && user
    ? { followers: { some: { userId: user.id } } }
    : {};

  const topics = anonymousFollowedFilter
    ? []
    : await prisma.topic.findMany({
        where: {
          enabled: true,
          ...tierFilter,
          ...followedFilter,
        },
        orderBy: [{ tier: 'asc' }, { candidateCount: 'desc' }, { updatedAt: 'desc' }],
        take: 80,
        select: {
          id: true,
          slug: true,
          name: true,
          summary: true,
          tier: true,
          candidateCount: true,
          sourceCount: true,
          lastSyncedAt: true,
          aggregationWindowEnd: true,
        },
      });

  // 不同筛选形态下的「未读议题」徽章总和，便于顶部 chip 展示。
  const unreadByFilter: Partial<Record<TopicFilterKey, number>> = {};
  if (user) {
    const allFollows = await prisma.topicFollow.findMany({
      where: { userId: user.id },
      select: { topicId: true, lastViewedAt: true },
    });
    const followedTopicIds = allFollows.map((f) => f.topicId);
    if (followedTopicIds.length > 0) {
      const unreadRows = await prisma.topicIssue.findMany({
        where: { topicId: { in: followedTopicIds }, status: 'active' },
        select: {
          topicId: true,
          id: true,
          title: true,
          proposition: true,
          kind: true,
          importanceScore: true,
          lastSeenAt: true,
          candidates: { select: { summaryId: true } },
        },
      });
      let totalUnread = 0;
      const lastViewByTopic = new Map(allFollows.map((f) => [f.topicId, f.lastViewedAt] as const));
      const rowsByTopic = new Map<string, typeof unreadRows>();
      for (const row of unreadRows) {
        const rows = rowsByTopic.get(row.topicId) ?? [];
        rows.push(row);
        rowsByTopic.set(row.topicId, rows);
      }
      for (const [topicId, rows] of rowsByTopic) {
        const publicIssues = collapseTopicIssues(
          rows.map((row) => ({
            id: row.id,
            kind: row.kind,
            title: row.title,
            proposition: row.proposition,
            candidateIds: (row.candidates ?? []).map((candidate) => candidate.summaryId),
            importanceScore: row.importanceScore,
            lastSeenAt: row.lastSeenAt,
          })),
        );
        const lastViewedAt = lastViewByTopic.get(topicId) ?? null;
        totalUnread += publicIssues.filter((issue) => (
          !lastViewedAt || issue.lastSeenAt > lastViewedAt
        )).length;
      }
      unreadByFilter.followed = totalUnread;
    } else {
      unreadByFilter.followed = 0;
    }
  }

  if (topics.length === 0) {
    return (
      <div className={styles.screen} data-topics-screen>
        <PageHeader
          title="技术专题"
          description="把分散的雷达信号聚成可持续追踪的研究脉络；先看正在升温的专题，再进入综述、热点议题和团队研究。"
          actions={
            <Link href="/me/topics" className={styles.overviewLink}>
              {user ? '我的专题总览' : '登录后查看我的专题'}
            </Link>
          }
        />
        <TopicsFilter unreadByFilter={unreadByFilter} />
        <EmptyState
          title={
            filter === 'followed'
              ? user
                ? '还没有关注任何专题'
                : '登录后查看已关注专题'
              : '暂无专题'
          }
          description={
            filter === 'followed'
              ? user
                ? '切换到「全部专题」，点开一个再关注；专题内的热点议题会自动聚合并按未读顺序展示。'
                : '登录后即可查看自己关注的专题和未读热点议题。'
              : '下一轮雷达同步将自动建组。'
          }
        />
      </div>
    );
  }
  const topicIds = topics.map((t) => t.id);

  const [follows, issueStats, latestResearch] = await Promise.all([
    user
      ? prisma.topicFollow.findMany({
          where: { userId: user.id, topicId: { in: topicIds } },
          select: { topicId: true, lastViewedAt: true },
        })
      : Promise.resolve([] as Array<{ topicId: string; lastViewedAt: Date | null }>),
    prisma.topicIssue.findMany({
      where: { topicId: { in: topicIds }, status: 'active' },
      select: {
        topicId: true,
        id: true,
        title: true,
        proposition: true,
        kind: true,
        importanceScore: true,
        lastSeenAt: true,
        candidates: { select: { summaryId: true } },
      },
    }),
    prisma.researchTopic.findMany({
      where: { topicId: { in: topicIds }, research: { status: 'published' } },
      orderBy: { createdAt: 'desc' },
      distinct: ['topicId'],
      select: {
        topicId: true,
        research: { select: { id: true, title: true, status: true } },
      },
      take: topicIds.length * 2,
    }),
  ]);

  const followedMap = new Map(follows.map((f) => [f.topicId, f.lastViewedAt] as const));
  const issueRowsByTopic = new Map<string, Array<{
    id: string;
    title: string;
    proposition: string;
    kind: string;
    importanceScore: number;
    lastSeenAt: Date;
    candidateIds: string[];
  }>>();
  for (const row of issueStats) {
    const list = issueRowsByTopic.get(row.topicId) ?? [];
    list.push({
      id: row.id,
      title: row.title,
      proposition: row.proposition,
      kind: row.kind,
      importanceScore: row.importanceScore,
      lastSeenAt: row.lastSeenAt,
      candidateIds: (row.candidates ?? []).map((candidate) => candidate.summaryId),
    });
    issueRowsByTopic.set(row.topicId, list);
  }
  const activeIssueDatesByTopic = new Map<string, Date[]>();
  for (const [topicId, rows] of issueRowsByTopic) {
    activeIssueDatesByTopic.set(
      topicId,
      collapseTopicIssues(rows).map((issue) => issue.lastSeenAt),
    );
  }
  const researchByTopic = new Map<string, { id: string; title: string; status: string }>();
  for (const row of latestResearch) {
    if (!researchByTopic.has(row.topicId)) {
      researchByTopic.set(row.topicId, {
        id: row.research.id,
        title: row.research.title,
        status: row.research.status,
      });
    }
  }

  return (
    <div className={styles.screen} data-topics-screen>
      <PageHeader
        title="技术专题"
        description="把分散的雷达信号聚成可持续追踪的研究脉络；先看正在升温的专题，再进入综述、热点议题和团队研究。"
        actions={
          <Link href="/me/topics" className={styles.overviewLink}>
            {user ? '我的专题总览' : '登录后查看我的专题'}
          </Link>
        }
      />
      <TopicsFilter unreadByFilter={unreadByFilter} />
      <ul className={styles.grid} aria-label="专题列表">
        {topics.map((t) => {
          const TierIcon = TIER_ICONS[t.tier] ?? Compass;
          const isFollowed = followedMap.has(t.id);
          const lastViewedAt = followedMap.get(t.id) ?? null;
          const activeDates = activeIssueDatesByTopic.get(t.id) ?? [];
          const unreadCount = isFollowed
            ? lastViewedAt
              ? activeDates.filter((d) => d.getTime() > lastViewedAt.getTime()).length
              : activeDates.length
            : 0;
          const research = researchByTopic.get(t.id) ?? null;
          return (
            <li key={t.id}>
              <Link href={`/topics/${t.slug}`} className={styles.cardLink} aria-labelledby={`topic-${t.id}`}>
                <Paper component="article" variant="outlined" className={`${styles.card} material-surface`}>
                    <header className={styles.cardHeader}>
                      <StatusBadge kind="topicTier" value={t.tier} icon={<TierIcon aria-hidden />} />
                      {isFollowed ? (
                        <Chip size="small" label="已关注" className={styles.followed} />
                      ) : null}
                      {unreadCount > 0 ? (
                        <Chip size="small" label={`${unreadCount} 个新议题`} icon={<Bell aria-hidden />} className={styles.unread} />
                      ) : null}
                    </header>
                    <h2 id={`topic-${t.id}`} className={styles.title}>{t.name}</h2>
                    {t.summary ? (
                      <p className={styles.summary}>{t.summary}</p>
                    ) : null}
                    {research ? (
                      <p className={styles.research}>
                        <BookOpenCheck aria-hidden />
                        <span>已有团队研究：{research.title.slice(0, 32)}</span>
                      </p>
                    ) : null}
                    <div className={styles.metadata}>
                      <span>{t.candidateCount} 条相关内容</span>
                      <span>{activeIssueDatesByTopic.get(t.id)?.length ?? 0} 个活跃议题</span>
                      <span>{t.sourceCount} 个采集渠道</span>
                      {t.lastSyncedAt
                        ? <time dateTime={t.lastSyncedAt.toISOString()}>{t.lastSyncedAt.toLocaleDateString('zh-CN')}</time>
                        : <span className={styles.syncStatus}>待同步</span>}
                    </div>
                </Paper>
              </Link>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
