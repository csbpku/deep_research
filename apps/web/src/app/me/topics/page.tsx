// /me/topics — 当前用户关注的主题 (P1-D)
import Link from 'next/link';
import { redirect } from 'next/navigation';
import { ArrowLeft, Pin } from 'lucide-react';

import { prisma } from '@/lib/db';
import { getCurrentUser } from '@/lib/auth/session';
import { PageHeader } from '@/components/domain/PageHeader';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { EmptyState } from '@/components/EmptyState';

const TIER_LABELS: Record<string, { label: string; cls: string }> = {
  hot: { label: '热门', cls: 'bg-status-failed-bg text-status-failed-fg' },
  warming: { label: '升温', cls: 'bg-status-running-bg text-status-running-fg' },
  emerging: { label: '新出现', cls: 'bg-muted text-muted-foreground' },
};

export default async function MyTopicsPage() {
  const user = await getCurrentUser();
  if (!user) redirect('/signin?callbackUrl=/me/topics');

  const follows = await prisma.topicFollow.findMany({
    where: { userId: user.id },
    orderBy: { createdAt: 'desc' },
    include: { topic: true },
  });

  return (
    <div className="mx-auto max-w-shell">
      <Link href="/me" className="mb-2 inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground">
        <ArrowLeft className="size-3" />
        返回我的
      </Link>
      <PageHeader title="我的主题关注" description="集中查看你关注的热点主题与最新候选。" />
      {follows.length === 0 ? (
        <EmptyState
          title="还没有关注"
          description="到 主题列表 浏览后点击关注。"
          action={
            <Link href="/topics" className="text-sm text-primary hover:underline">
              去主题列表 →
            </Link>
          }
        />
      ) : (
        <ul className="grid list-none gap-2 p-0">
          {follows.map((f) => {
            const t = f.topic;
            const tier = TIER_LABELS[t.tier] ?? TIER_LABELS.emerging;
            return (
              <li key={f.id}>
                <Card>
                  <CardContent className="flex items-center gap-3 p-4">
                    <Pin className="size-4 shrink-0 text-muted-foreground" />
                    <div className="flex-1 min-w-0">
                      <div className="flex flex-wrap items-center gap-1.5">
                        <Badge className={tier.cls}>{tier.label}</Badge>
                        <h2 className="text-sm font-semibold">
                          <Link href={`/topics/${t.slug}`} className="hover:text-primary hover:underline">
                            {t.name}
                          </Link>
                        </h2>
                      </div>
                      {t.summary ? (
                        <p className="mt-1 line-clamp-2 text-xs text-muted-foreground">{t.summary}</p>
                      ) : null}
                      <p className="mt-1 text-xs text-muted-foreground">
                        候选 {t.candidateCount} · 关注于 {new Date(f.createdAt).toLocaleDateString('zh-CN')}
                      </p>
                    </div>
                  </CardContent>
                </Card>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
