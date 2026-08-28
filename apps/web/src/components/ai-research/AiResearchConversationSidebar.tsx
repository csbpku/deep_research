'use client';

import { useEffect } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useQuery } from '@tanstack/react-query';
import { MessageSquare, Plus, Sparkles } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import type { AiResearchConversationSummary } from '@/lib/ai-research-chat';
import { friendlyMessage } from '@/lib/errors/friendly';
import { retryOnceAi } from '@/lib/errors/friendly';
import { cn } from '@/lib/utils';

function relativeTime(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  if (Number.isNaN(ms) || ms < 0) return '刚刚';
  const min = Math.floor(ms / 60_000);
  if (min < 1) return '刚刚';
  if (min < 60) return `${min} 分钟前`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr} 小时前`;
  const day = Math.floor(hr / 24);
  if (day < 7) return `${day} 天前`;
  return `${Math.floor(day / 30)} 个月前`;
}

export function AiResearchConversationSidebar({
  activeConversationId,
}: {
  activeConversationId?: string | null;
}) {
  const router = useRouter();
  const query = useQuery<{ items: AiResearchConversationSummary[] }>({
    queryKey: ['ai-research-conversations'],
    queryFn: async () => {
      const response = await fetch('/api/ai-research/conversations', { cache: 'no-store' });
      if (!response.ok) throw new Error(`conversations ${response.status}`);
      return await response.json() as { items: AiResearchConversationSummary[] };
    },
    retry: retryOnceAi,
  });

  // 新建对话或恢复对话后，刷新侧栏让最新会话排到顶部。
  useEffect(() => {
    void query.refetch();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeConversationId]);

  return (
    <aside className="flex min-h-0 flex-col rounded-2xl border border-border bg-card shadow-sm" aria-label="最近对话">
      <div className="border-b border-border p-3">
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="w-full justify-start"
          onClick={() => router.push('/ai-research')}
        >
          <Plus className="size-4" />
          新建对话
        </Button>
      </div>
      <div className="flex min-h-0 flex-1 flex-col overflow-y-auto p-2">
        <span className="px-2 py-1.5 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
          最近对话
        </span>
        {query.isLoading ? (
          <div className="space-y-2 px-2">
            {[0, 1, 2].map((i) => (
              <Skeleton key={i} className="h-12 w-full rounded-md" />
            ))}
          </div>
        ) : query.isError ? (
          <p className="px-2 text-xs text-destructive">{friendlyMessage(query.error, '对话列表加载失败')}</p>
        ) : query.data?.items.length === 0 ? (
          <p className="px-2 py-2 text-xs text-muted-foreground">还没有对话，先提出一个问题吧。</p>
        ) : (
          <ul className="space-y-1">
            {query.data?.items.map((conversation) => {
              const active = conversation.id === activeConversationId;
              return (
                <li key={conversation.id}>
                  <Link
                    href={conversation.jobId ? `/ai-research/${conversation.jobId}` : `/ai-research?conversation=${conversation.id}`}
                    className={cn(
                      'flex items-start gap-2 rounded-lg px-2.5 py-2 text-sm transition-colors',
                      active ? 'bg-primary/10 text-foreground' : 'text-muted-foreground hover:bg-muted/60 hover:text-foreground',
                    )}
                    aria-current={active ? 'page' : undefined}
                  >
                    <MessageSquare className="mt-0.5 size-3.5 shrink-0" />
                    <span className="min-w-0 flex-1">
                      <span className="line-clamp-2 block leading-5">{conversation.title}</span>
                      <span className="mt-0.5 block text-[11px] text-muted-foreground/70">
                        {relativeTime(conversation.updatedAt)}
                        {conversation.jobId ? ' · 已启动' : ''}
                      </span>
                    </span>
                  </Link>
                </li>
              );
            })}
          </ul>
        )}
      </div>
      <div className="flex items-center gap-1.5 border-t border-border px-3 py-2.5 text-[11px] text-muted-foreground">
        <Sparkles className="size-3.5" />
        对话自动保存，可随时回来继续
      </div>
    </aside>
  );
}
