'use client';

// /summaries — AI 雷达日报列表。
//
// 新模式：每天一条 digest://YYYY-MM-DD 的 published summary，内容为跨来源
// 总结文章；列表只展示日报入口，不再按日期铺开 4 条手工精选。
//
// ⚠️ e2e 断言正文含 /雷达日报|日报/，勿改标题文案。

import { useQuery } from '@tanstack/react-query';
import Link from 'next/link';
import { AlertTriangle, ArrowRight } from 'lucide-react';

import { EmptyState } from '@/components/EmptyState';
import { PageHeader } from '@/components/domain/PageHeader';
import { Skeleton } from '@/components/ui/skeleton';

interface DigestRankedItem {
  summaryId: string | null;
  title: string;
  url: string;
  radarUrl: string | null;
  oneLineReason: string;
}

interface DigestListArticle {
  summaryId: string;
  date: string;
  title: string;
  publishedAt: string | null;
  tldr: string;
  sections: Array<{ title: string; body: string }>;
  highlights: string[];
  ranked: DigestRankedItem[];
  sourcesUsed: string[];
  candidateCount: number;
  narrativeDegraded: boolean;
  model: string | null;
  generatedAt: string | null;
}

interface DigestListResponse {
  dates: DigestListArticle[];
  total: number;
}

function formatTime(iso: string | null): string {
  if (!iso) return '—';
  return new Date(iso).toISOString().replace('T', ' ').slice(0, 16) + ' UTC';
}

export default function SummariesPage() {
  const q = useQuery<DigestListResponse>({
    queryKey: ['digests'],
    queryFn: async () => {
      const r = await fetch('/api/summaries?limit=30', { cache: 'no-store' });
      if (!r.ok) {
        const err = await r.json().catch(() => ({ message: '加载失败' }));
        throw new Error(err.message ?? '加载失败');
      }
      return (await r.json()) as DigestListResponse;
    },
  });

  return (
    <div className="mx-auto max-w-shell">
      <PageHeader
        title="AI 雷达日报"
        description="每天一篇跨来源总结：今日看点、分类综述与信号榜单。"
      />

      {q.isLoading ? (
        <div className="grid gap-3">
          {[0, 1, 2].map((i) => (
            <div key={i} className="space-y-2 rounded-lg border border-border bg-card p-4">
              <Skeleton className="h-4 w-32" />
              <Skeleton className="h-4 w-2/3" />
              <Skeleton className="h-3 w-full" />
            </div>
          ))}
        </div>
      ) : q.isError ? (
        <EmptyState title="加载失败" description={String((q.error as Error).message)} />
      ) : (q.data?.dates.length ?? 0) === 0 ? (
        <EmptyState title="暂无日报" description="完成雷达同步后会自动生成每日总结文章。" />
      ) : (
        <div className="grid gap-3">
          {q.data!.dates.map((d) => (
            <Link
              key={d.summaryId}
              href={`/summaries/${d.date}`}
              className="group block rounded-lg border border-border bg-card p-4 transition-colors duration-200 hover:border-primary/40 hover:bg-accent/30 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              <div className="flex flex-wrap items-baseline gap-2.5">
                <h2 className="font-mono text-base font-semibold tabular-nums">{d.date}</h2>
                <span className="text-xs text-muted-foreground">{formatTime(d.publishedAt)}</span>
                {d.narrativeDegraded ? (
                  <span className="inline-flex items-center gap-1 rounded-full bg-status-partial-bg px-2 py-0.5 text-xs text-status-partial-fg">
                    <AlertTriangle className="size-3" />
                    降级生成
                  </span>
                ) : null}
                <ArrowRight className="ml-auto size-4 text-muted-foreground transition-transform duration-200 group-hover:translate-x-0.5 group-hover:text-primary" />
              </div>

              <h3 className="mt-2 text-sm font-medium leading-snug">{d.title}</h3>

              {d.tldr ? (
                <p className="mt-1.5 line-clamp-3 text-sm leading-relaxed text-muted-foreground">
                  {d.tldr}
                </p>
              ) : null}

            </Link>
          ))}
        </div>
      )}
    </div>
  );
}
