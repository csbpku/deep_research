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
import { Card, CardContent } from '@/components/ui/card';

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

function formatPublishTime(iso: string | null): string {
  if (!iso) return '—';
  return new Date(iso).toLocaleTimeString('zh-CN', {
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
}

function displayTitle(title: string): string {
  return title.replace(/\s*·\s*\d{4}-\d{2}-\d{2}$/u, '');
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
        description="每天一篇跨来源总结，提炼值得先读的信号。"
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
        <div className="relative grid gap-3 sm:pl-8">
          <div className="absolute bottom-3 left-2 top-3 hidden w-px bg-border sm:block" aria-hidden />
          {q.data!.dates.map((d, index) => (
            <Link
              key={d.summaryId}
              href={`/summaries/${d.date}`}
              className="group block rounded-lg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              <Card className={`transition-all duration-200 group-hover:-translate-y-px group-hover:border-primary/40 group-hover:shadow-sm ${index === 0 ? 'border-l-2 border-l-primary bg-gradient-to-br from-card to-accent/25' : ''}`}>
                <CardContent className={index === 0 ? 'min-h-48 p-5' : 'p-4'}>
                  <div className="flex flex-wrap items-baseline gap-2.5">
                    <h2 className="font-mono text-base font-semibold tabular-nums">{d.date}</h2>
                    <span className="text-xs text-muted-foreground">更新于 {formatPublishTime(d.publishedAt)}</span>
                    {d.narrativeDegraded ? (
                      <span className="inline-flex items-center gap-1 rounded-full bg-status-partial-bg px-2 py-0.5 text-xs text-status-partial-fg">
                        <AlertTriangle className="size-3" />
                        降级生成
                      </span>
                    ) : null}
                    <ArrowRight className="ml-auto size-4 text-muted-foreground transition-transform duration-200 group-hover:translate-x-0.5 group-hover:text-primary" />
                  </div>

                  <h3 className={`${index === 0 ? 'mt-3 text-xl' : 'mt-2 text-sm'} font-semibold leading-snug tracking-normal`}>{displayTitle(d.title)}</h3>

                  {d.tldr ? (
                    <p className={`${index === 0 ? 'mt-3 text-[15px] leading-7' : 'mt-1.5 text-sm leading-relaxed'} line-clamp-3 text-muted-foreground`}>
                      {d.tldr}
                    </p>
                  ) : null}
                  {index === 0 && d.highlights.length > 0 ? (
                    <div className="mt-4 flex flex-wrap gap-1.5">
                      {d.highlights.slice(0, 3).map((highlight, highlightIndex) => <span key={`${highlight}-${highlightIndex}`} className="rounded-full border border-primary/20 bg-primary/5 px-2 py-0.5 text-[11px] text-primary">{highlight}</span>)}
                    </div>
                  ) : null}
                </CardContent>
              </Card>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}
