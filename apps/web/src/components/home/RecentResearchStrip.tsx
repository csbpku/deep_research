'use client';

// 首页"调研库精选" —— 登录态展示已发布的研究/知识卡片 2x2 缩略图。
//
// 数据源：复用 /api/researches?scope=published&limit=4（不传 type 同时拿 research + knowledge，
// 已在 researchListWhere 里实现 type 可选过滤）。该路由内部 requireUser，
// 所以本组件仅在登录态挂载即可。

import Link from 'next/link';
import { useQuery } from '@tanstack/react-query';
import { Library, Star } from 'lucide-react';

import { SectionCard } from '@/components/domain/SectionCard';
import { StatusBadge } from '@/components/domain/StatusBadge';
import { TagChip, TagList } from '@/components/domain/TagChip';
import { Skeleton } from '@/components/ui/skeleton';

interface ResearchItem {
  id: string;
  type: string;
  status: string;
  title: string;
  body: string;
  tags: string[];
  creationMethod: string;
  aiAssisted: boolean;
  publishedAt: string | null;
  featuredAt: string | null;
  createdAt: string;
  author: { id: string; name: string };
}

interface ResearchListResponse {
  items: ResearchItem[];
  page: number;
  limit: number;
  total: number;
  totalPages: number;
}

function formatTimeAgo(iso: string | null): string {
  if (!iso) return '—';
  const ms = Date.now() - new Date(iso).getTime();
  if (ms < 60_000) return '刚刚';
  if (ms < 3_600_000) return `${Math.floor(ms / 60_000)} 分钟前`;
  if (ms < 86_400_000) return `${Math.floor(ms / 3_600_000)} 小时前`;
  return new Date(iso).toLocaleDateString('zh-CN');
}

function excerpt(body: string, max: number): string {
  const plainText = body.replace(/[#*`>\-\[\]()!_~|]/g, '').replace(/\s+/g, ' ').trim();
  if (plainText.length <= max) return plainText;
  return plainText.slice(0, max) + '…';
}

export function RecentResearchStrip() {
  const { data, isLoading } = useQuery<ResearchListResponse>({
    queryKey: ['home', 'researches'],
    queryFn: async () => {
      const params = new URLSearchParams({ scope: 'published', limit: '4' });
      const r = await fetch(`/api/researches?${params.toString()}`, { cache: 'no-store' });
      if (!r.ok) throw new Error(`researches fetch failed: ${r.status}`);
      return r.json();
    },
    staleTime: 60_000,
    retry: 1,
  });

  const items = [...(data?.items ?? [])]
    .sort((a, b) => {
      const fa = a.featuredAt ? 1 : 0;
      const fb = b.featuredAt ? 1 : 0;
      if (fa !== fb) return fb - fa;
      return (b.publishedAt ?? b.createdAt).localeCompare(a.publishedAt ?? a.createdAt);
    })
    .slice(0, 4);

  // 加载中或空数据 → 不渲染区块（与首页"empty = direction, not mood"哲学一致）
  if (!isLoading && items.length === 0) return null;

  return (
    <div className="mt-6">
      <SectionCard
        title="调研库精选"
        icon={Library}
        actions={
          <Link href="/researches" className="text-xs text-primary hover:underline">
            查看全部 →
          </Link>
        }
      >
        {isLoading ? (
          <div className="grid gap-3 md:grid-cols-2">
            {[0, 1, 2, 3].map((i) => (
              <Skeleton key={i} className="h-24 w-full" />
            ))}
          </div>
        ) : (
          <ul className="grid gap-3 md:grid-cols-2">
            {items.map((item) => (
              <li key={item.id}>
                <Link
                  href={`/researches/${item.id}`}
                  className="group flex h-full min-w-0 flex-col gap-2 rounded-md border border-border bg-card p-3 transition-all duration-200 hover:-translate-y-px hover:border-primary/40 hover:shadow-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                >
                  <div className="flex flex-wrap items-center gap-1.5">
                    <StatusBadge kind="method" value={item.creationMethod} />
                    {item.featuredAt ? (
                      <span className="inline-flex items-center gap-1 rounded-full border border-amber-400/60 bg-amber-400/10 px-2 py-0.5 text-xs font-medium text-amber-700 dark:text-amber-300">
                        <Star className="size-3" />
                        精华
                      </span>
                    ) : null}
                  </div>
                  <h3 className="line-clamp-2 text-sm font-semibold leading-snug tracking-normal group-hover:text-primary">
                    {item.title}
                  </h3>
                  <p className="line-clamp-2 text-xs leading-relaxed text-muted-foreground">
                    {excerpt(item.body, 140)}
                  </p>
                  {item.tags.length > 0 ? (
                    <TagList className="mt-auto">
                      {item.tags.slice(0, 2).map((t) => (
                        <TagChip key={t}>{t}</TagChip>
                      ))}
                      {item.tags.length > 2 ? (
                        <span className="font-mono text-[11px] text-muted-foreground">
                          +{item.tags.length - 2}
                        </span>
                      ) : null}
                    </TagList>
                  ) : null}
                  <div className="flex items-center gap-2 text-[11px] text-muted-foreground">
                    <span className="truncate">{item.author.name}</span>
                    <span aria-hidden>·</span>
                    <span className="font-mono tabular-nums">
                      {formatTimeAgo(item.publishedAt ?? item.createdAt)}
                    </span>
                  </div>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </SectionCard>
    </div>
  );
}
