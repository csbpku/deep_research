// /me/topics — 当前用户关注的技术专题（ADR 0010 升级：未读议题 + 最近变化）。
import * as React from 'react';
import Link from 'next/link';
import { redirect } from 'next/navigation';
import { ArrowLeft, BookOpenCheck, Compass, Sparkles, TrendingUp } from 'lucide-react';
import Paper from '@mui/material/Paper';
import Chip from '@mui/material/Chip';

import { prisma } from '@/lib/db';
import { getCurrentUser } from '@/lib/auth/session';
import { collapseTopicIssues } from '@/lib/topics';
import { PageHeader } from '@/components/domain/PageHeader';
import { StatusBadge } from '@/components/domain/StatusBadge';
import { AppButton } from '@/components/material/AppButton';
import { EmptyState } from '@/components/EmptyState';
import styles from './my-topics.module.css';

/** Tier icon 与颜色 —— 颜色由 StatusBadge kind="topicTier" 统一管理 */
const TIER_ICONS: Record<string, typeof Compass> = {
  hot: TrendingUp,
  warming: Sparkles,
  emerging: Compass,
};

/** 相对时间格式：避免全 `toLocaleString` 在数据密集页视觉拥挤 */
function formatRelative(iso: string | Date): string {
  const d = typeof iso === 'string' ? new Date(iso) : iso;
  const diff = Date.now() - d.getTime();
  const minute = 60_000, hour = 3_600_000, day = 86_400_000;
  if (diff < minute) return '刚刚';
  if (diff < hour) return `${Math.floor(diff / minute)} 分钟前`;
  if (diff < day) return `${Math.floor(diff / hour)} 小时前`;
  if (diff < 30 * day) return `${Math.floor(diff / day)} 天前`;
  return d.toLocaleDateString('zh-CN');
}

export const dynamic = 'force-dynamic';

export default async function MyTopicsPage() {
  const user = await getCurrentUser();
  if (!user) redirect('/signin?callbackUrl=/me/topics');

  const follows = await prisma.topicFollow.findMany({
    where: { userId: user.id },
    orderBy: [{ lastViewedAt: { sort: 'desc', nulls: 'last' } }, { createdAt: 'desc' }],
    include: { topic: true },
  });
  if (follows.length === 0) {
    return (
      <div className={styles.screen} data-my-topics-screen>
        <AppButton component={Link} href="/me" variant="text" size="small" startIcon={<ArrowLeft aria-hidden />} className={styles.back}>返回我的</AppButton>
        <PageHeader
          title="我的技术专题"
          description="长期关注的技术对象（专题 = 把同一类技术话题聚合到一起的卡片，例如「LLM 评估」「RAG 架构」）；新出现的热点议题会出现在这里。"
        />
        <EmptyState
          title="还没有关注"
          description="到「专题列表」浏览并点击任一专题的关注按钮；专题内的热点议题会自动聚合并按未读顺序展示。"
          action={
            <AppButton component={Link} href="/topics" variant="outlined" size="small">去专题列表 →</AppButton>
          }
        />
      </div>
    );
  }

  const topicIds = follows.map((f) => f.topicId);
  const issues = await prisma.topicIssue.findMany({
    where: { topicId: { in: topicIds }, status: 'active' },
    orderBy: { lastSeenAt: 'desc' },
    select: {
      id: true,
      topicId: true,
      title: true,
      proposition: true,
      kind: true,
      importanceScore: true,
      lastSeenAt: true,
      candidates: { select: { summaryId: true } },
    },
  });
  const issueRowsByTopic = new Map<string, typeof issues>();
  for (const issue of issues) {
    const rows = issueRowsByTopic.get(issue.topicId) ?? [];
    rows.push(issue);
    issueRowsByTopic.set(issue.topicId, rows);
  }
  const issuesByTopic = new Map<string, ReturnType<typeof collapseTopicIssues>>();
  for (const [topicId, rows] of issueRowsByTopic) {
    issuesByTopic.set(
      topicId,
      collapseTopicIssues(
        rows.map((issue) => ({
          id: issue.id,
          title: issue.title,
          proposition: issue.proposition,
          kind: issue.kind,
          importanceScore: issue.importanceScore,
          lastSeenAt: issue.lastSeenAt,
          candidateIds: (issue.candidates ?? []).map((candidate) => candidate.summaryId),
        })),
      ),
    );
  }

  const latestResearch = await prisma.researchTopic.findMany({
    where: { topicId: { in: topicIds }, research: { status: 'published' } },
    orderBy: { createdAt: 'desc' },
    distinct: ['topicId'],
    select: {
      topicId: true,
      createdAt: true,
      research: { select: { id: true, title: true, status: true } },
    },
    take: topicIds.length * 2,
  });
  const researchByTopic = new Map<string, { id: string; title: string; status: string; at: string }>();
  for (const row of latestResearch) {
    if (!researchByTopic.has(row.topicId)) {
      researchByTopic.set(row.topicId, {
        id: row.research.id,
        title: row.research.title,
        status: row.research.status,
        at: row.createdAt.toISOString(),
      });
    }
  }

  let totalUnread = 0;

  return (
    <div className={styles.screen} data-my-topics-screen>
      <AppButton component={Link} href="/me" variant="text" size="small" startIcon={<ArrowLeft aria-hidden />} className={styles.back}>返回我的</AppButton>
      <PageHeader
        title="我的技术专题"
        description="关注长期跟踪的技术对象；出现新的热点议题会自动显示在这里，按未读顺序排列。"
      />
      <ul className={styles.list} aria-label="我关注的专题">
        {follows.map((f) => {
          const t = f.topic;
          const TierIcon = TIER_ICONS[t.tier] ?? Compass;
          const list = issuesByTopic.get(t.id) ?? [];
          let unread = list.length;
          const last = f.lastViewedAt;
          if (last) {
            unread = list.filter((i) => (
              (typeof i.lastSeenAt === 'string' ? Date.parse(i.lastSeenAt) : i.lastSeenAt.getTime()) > last.getTime()
            )).length;
          }
          const top = list[0];
          const latest = researchByTopic.get(t.id) ?? null;
          totalUnread += unread;
          return (
            <li key={f.id}>
              <Paper component="article" variant="outlined" className={styles.card} aria-labelledby={`followed-topic-${t.id}`}>
                  <div className={styles.badges}>
                    <StatusBadge kind="topicTier" value={t.tier} icon={<TierIcon aria-hidden />} />
                    {unread > 0 ? (
                      <Chip component="span" size="small" label={`${unread} 个未读议题`} className={styles.unread} />
                    ) : null}
                    {latest ? (
                      <Chip component="span" size="small" label="已有团队研究" className={styles.related} />
                    ) : null}
                  </div>
                  <h2 id={`followed-topic-${t.id}`} className={styles.title}>
                    <Link href={`/topics/${t.slug}`} className={styles.topicLink}>{t.name}</Link>
                  </h2>
                  {top ? (
                    <div className={styles.issue}>
                      <div className={styles.issueTitle}>
                        <BookOpenCheck aria-hidden />
                        <span>{top.title}</span>
                      </div>
                      <p className={styles.proposition}>{top.proposition}</p>
                    </div>
                  ) : null}
                  <div className={styles.metadata}>
                    <span>{t.candidateCount} 条相关内容</span>
                    <span>{list.length} 个活跃议题</span>
                    <span>上次查看 {f.lastViewedAt ? <time dateTime={f.lastViewedAt.toISOString()}>{formatRelative(f.lastViewedAt)}</time> : '从未'}</span>
                    {latest ? (
                      <Link href={`/researches/${latest.id}`} className={styles.researchLink}>
                        最近研究：{latest.title}
                      </Link>
                    ) : null}
                  </div>
              </Paper>
            </li>
          );
        })}
      </ul>
      <p className={styles.total}>
        共 {follows.length} 个专题，{totalUnread} 个未读议题
      </p>
    </div>
  );
}
