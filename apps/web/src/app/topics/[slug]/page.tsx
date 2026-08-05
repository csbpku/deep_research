// /topics/[slug] — 主题详情 (P1-D)
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { ArrowLeft, CalendarRange, ExternalLink, FileText, ListTree, Sparkles } from 'lucide-react';

import { prisma } from '@/lib/db';
import { getCurrentUser } from '@/lib/auth/session';
import { PageHeader } from '@/components/domain/PageHeader';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { TopicFollowButton } from '@/components/topics/TopicFollowButton';
import { formatSourceType } from '@/lib/radar/source-labels';

const TIER_LABELS: Record<string, { label: string; cls: string }> = {
  hot: { label: '热门', cls: 'bg-status-failed-bg text-status-failed-fg' },
  warming: { label: '升温', cls: 'bg-status-running-bg text-status-running-fg' },
  emerging: { label: '新出现', cls: 'bg-muted text-muted-foreground' },
};

interface SynthesisPayload {
  tldr?: string;
  sections?: Array<{ title: string; content: string }>;
  references?: Array<{ summaryId: string; kind?: string }>;
}

export default async function TopicDetailPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const user = await getCurrentUser();
  const topic = await prisma.topic.findUnique({ where: { slug } });
  if (!topic) notFound();

  const [candidates, followed] = await Promise.all([
    prisma.topicCandidate.findMany({
      where: { topicId: topic.id },
      orderBy: { addedAt: 'desc' },
      take: 50,
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
            originalFetchedAt: true,
            createdAt: true,
          },
        },
      },
    }),
    user
      ? prisma.topicFollow.findUnique({ where: { userId_topicId: { userId: user.id, topicId: topic.id } } })
      : Promise.resolve(null),
  ]);

  const tier = TIER_LABELS[topic.tier] ?? TIER_LABELS.emerging;
  const synthesis = topic.synthesisPayload as SynthesisPayload | null;

  // 时间线：按 createdAt 升序；同日期聚合展示
  const timeline = [...candidates].sort(
    (a, b) => new Date(a.summary.createdAt).getTime() - new Date(b.summary.createdAt).getTime(),
  );

  return (
    <div className="mx-auto max-w-shell">
      <Link href="/topics" className="mb-2 inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground">
        <ArrowLeft className="size-3" />
        返回主题列表
      </Link>
      <PageHeader
        title={topic.name}
        description={topic.summary ?? undefined}
        actions={
          <div className="flex items-center gap-2">
            <Badge className={tier.cls}>{tier.label}</Badge>
            {user ? (
              <TopicFollowButton slug={topic.slug} initialFollowed={!!followed} />
            ) : null}
          </div>
        }
      />

      <div className="grid gap-4 md:grid-cols-[2fr_1fr]">
        <div className="space-y-4">
          {/* 综述 */}
          <Card>
            <CardContent className="p-4">
              <h2 className="mb-2 flex items-center gap-1.5 text-sm font-semibold">
                <Sparkles className="size-4 text-muted-foreground" />
                AI 综述
              </h2>
              {topic.synthesisErrorCode ? (
                <div className="space-y-2">
                  <p className="text-sm text-destructive">综述生成失败（{topic.synthesisErrorCode}）：{topic.synthesisErrorMessage}</p>
                  {user?.role === 'admin' ? (
                    <form action={`/api/topics/${topic.slug}/synthesis/retry`} method="post">
                      <Button type="submit" size="sm" variant="outline">
                        重试综述
                      </Button>
                    </form>
                  ) : null}
                </div>
              ) : synthesis && synthesis.tldr ? (
                <div className="space-y-3 text-sm">
                  <p className="font-medium">{synthesis.tldr}</p>
                  {synthesis.sections?.map((s, i) => (
                    <section key={i}>
                      <h3 className="mb-1 text-sm font-semibold">{s.title}</h3>
                      <p className="whitespace-pre-wrap leading-relaxed text-muted-foreground">{s.content}</p>
                    </section>
                  ))}
                </div>
              ) : (
                <p className="text-sm text-muted-foreground">综述生成中…</p>
              )}
            </CardContent>
          </Card>

          {/* 候选列表 */}
          <Card>
            <CardContent className="p-4">
              <h2 className="mb-2 flex items-center gap-1.5 text-sm font-semibold">
                <FileText className="size-4 text-muted-foreground" />
                候选（{candidates.length}）
              </h2>
              <ul className="grid list-none gap-2 p-0">
                {candidates.map((c) => (
                  <li key={c.id}>
                    <Link href={`/radar/${c.summary.id}`} className="block rounded-md border border-border p-2.5 transition-colors hover:border-primary/40">
                      <p className="text-sm font-medium hover:text-primary">{c.summary.title}</p>
                      <p className="mt-0.5 text-xs text-muted-foreground">
                        {formatSourceType(c.summary.originalKind).short} ·{' '}
                        {new Date(c.summary.publishedAt ?? c.summary.createdAt).toLocaleDateString('zh-CN')}
                        {c.summary.tags.length > 0 ? ` · ${c.summary.tags.slice(0, 3).join(', ')}` : ''}
                      </p>
                      {c.summary.interpretation ? (
                        <p className="mt-1 line-clamp-2 text-xs text-muted-foreground">{c.summary.interpretation}</p>
                      ) : null}
                    </Link>
                  </li>
                ))}
              </ul>
            </CardContent>
          </Card>
        </div>

        {/* 趋势 + 时间线 */}
        <div className="space-y-4">
          <Card>
            <CardContent className="p-4">
              <h2 className="mb-2 flex items-center gap-1.5 text-sm font-semibold">
                <CalendarRange className="size-4 text-muted-foreground" />
                趋势
              </h2>
              <p className="text-xs text-muted-foreground">
                聚合窗口：{new Date(topic.aggregationWindowStart).toLocaleDateString('zh-CN')} ~{' '}
                {new Date(topic.aggregationWindowEnd).toLocaleDateString('zh-CN')}
              </p>
              <p className="mt-2 text-xs text-muted-foreground">
                候选 {topic.candidateCount} · 来源 {topic.sourceCount} · 上次同步{' '}
                {topic.lastSyncedAt ? new Date(topic.lastSyncedAt).toLocaleString('zh-CN') : '—'}
              </p>
            </CardContent>
          </Card>

          <Card>
            <CardContent className="p-4">
              <h2 className="mb-2 flex items-center gap-1.5 text-sm font-semibold">
                <ListTree className="size-4 text-muted-foreground" />
                时间线
              </h2>
              <ol className="grid list-none gap-1.5 p-0 text-xs">
                {timeline.map((c) => (
                  <li key={c.id} className="flex items-start gap-2">
                    <span className="mt-1 inline-block size-1.5 shrink-0 rounded-full bg-primary" />
                    <div className="min-w-0 flex-1">
                      <p className="font-mono text-[10px] text-muted-foreground">
                        {new Date(c.summary.createdAt).toLocaleDateString('zh-CN')}
                      </p>
                      <Link href={`/radar/${c.summary.id}`} className="line-clamp-2 hover:text-primary hover:underline">
                        {c.summary.title}
                      </Link>
                    </div>
                  </li>
                ))}
              </ol>
            </CardContent>
          </Card>

          {synthesis?.references && synthesis.references.length > 0 ? (
            <Card>
              <CardContent className="p-4">
                <h2 className="mb-2 text-sm font-semibold">综述引用</h2>
                <ul className="grid list-none gap-1 p-0 text-xs">
                  {synthesis.references.map((r) => (
                    <li key={r.summaryId}>
                      <Link
                        href={`/radar/${r.summaryId}`}
                        className="inline-flex items-center gap-1 text-primary hover:underline"
                      >
                        <ExternalLink className="size-3" />
                        候选 {r.summaryId.slice(0, 8)}…
                      </Link>
                    </li>
                  ))}
                </ul>
              </CardContent>
            </Card>
          ) : null}
        </div>
      </div>
    </div>
  );
}
