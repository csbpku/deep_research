'use client';

import React from 'react';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useQuery } from '@tanstack/react-query';
import { MessageSquare, Plus, Sparkles } from 'lucide-react';

import { AiResearchButton as Button } from '@/components/ai-research/AiResearchMaterial';
import Box from '@mui/material/Box';
import Alert from '@mui/material/Alert';
import Paper from '@mui/material/Paper';
import Skeleton from '@mui/material/Skeleton';
import Typography from '@mui/material/Typography';
import { ErrorState } from '@/components/StateMessage';
import type { AiResearchConversationSummary } from '@/lib/ai-research-chat';
import { friendlyMessage } from '@/lib/errors/friendly';
import { retryOnceAi } from '@/lib/errors/friendly';
import { ApiHttpError, toApiHttpError } from '@/lib/errors/api-error';
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
  const pathname = usePathname();
  const query = useQuery<{ items: AiResearchConversationSummary[] }>({
    queryKey: ['ai-research-conversations', activeConversationId ?? null],
    queryFn: async () => {
      const response = await fetch('/api/ai-research/conversations', { cache: 'no-store' });
      if (!response.ok) throw await toApiHttpError(response, '对话列表加载失败');
      return await response.json() as { items: AiResearchConversationSummary[] };
    },
    retry: (count, error) => !(error instanceof ApiHttpError && error.status === 401) && retryOnceAi(count, error),
    refetchOnMount: (query) => !(query.state.error instanceof ApiHttpError && query.state.error.status === 401),
    refetchOnWindowFocus: (query) => !(query.state.error instanceof ApiHttpError && query.state.error.status === 401),
    refetchOnReconnect: (query) => !(query.state.error instanceof ApiHttpError && query.state.error.status === 401),
  });
  const loginRequired = query.isError && query.error instanceof ApiHttpError && query.error.status === 401;
  const callbackUrl = activeConversationId && pathname === '/ai-research'
    ? `/ai-research?${new URLSearchParams({ conversation: activeConversationId })}`
    : pathname || '/ai-research';

  return (
    <Paper component="aside" variant="outlined" aria-label="最近对话" sx={{ display: 'flex', minHeight: 0, flexDirection: 'column', overflow: 'hidden', maxHeight: { lg: '18rem' } }}>
      <Box sx={{ borderBottom: 1, borderColor: 'divider', p: 1.5 }}>
        <Button
          type="button"
          variant="outline"
          size="sm"
          fullWidth
          sx={{ justifyContent: 'flex-start' }}
          onClick={() => router.push('/ai-research')}
        >
          <Plus className="size-4" />
          新建对话
        </Button>
      </Box>
      <div className="flex min-h-0 flex-1 flex-col overflow-visible p-2 lg:overflow-y-auto">
        <span className="px-2 py-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          最近对话
        </span>
        {query.isLoading ? (
          <div className="space-y-2 px-2">
            {[0, 1, 2].map((i) => (
              <Skeleton key={i} variant="rounded" height={48} />
            ))}
          </div>
        ) : loginRequired ? (
          <Alert severity="info" action={
            <Button asChild variant="link" size="xs">
              <Link href={`/signin?${new URLSearchParams({ callbackUrl })}`}>登录</Link>
            </Button>
          }>
            登录后查看最近对话。
          </Alert>
        ) : query.isError ? (
          <ErrorState
            className="mx-2"
            title="对话列表加载失败"
            description={friendlyMessage(query.error, '请稍后重试。')}
            action={
              <Button type="button" size="xs" variant="outline" onClick={() => void query.refetch()}>
                重试
              </Button>
            }
          />
        ) : query.data?.items.filter((conversation) => conversation.jobId === null).length === 0 ? (
          <Typography component="p" variant="metadata" color="text.secondary" sx={{ px: 1, py: 1 }}>
            还没有未启动的对话。已启动的研究会在“最近任务”中保留。
          </Typography>
        ) : (
          <ul className="space-y-1">
            {query.data?.items.filter((conversation) => conversation.jobId === null).map((conversation) => {
              const active = conversation.id === activeConversationId;
              return (
                <li key={conversation.id}>
                  <Link
                    href={conversation.jobId ? `/ai-research/${conversation.jobId}` : `/ai-research?conversation=${conversation.id}`}
                    className={cn(
                      'flex items-start gap-2 rounded-lg px-3 py-2 text-sm transition-colors',
                      active ? 'bg-primary/10 text-foreground' : 'text-muted-foreground hover:bg-muted/60 hover:text-foreground',
                    )}
                    aria-current={active ? 'page' : undefined}
                  >
                    <MessageSquare className="mt-1 size-3.5 shrink-0" />
                    <span className="min-w-0 flex-1">
                      <span className="line-clamp-2 leading-5">{conversation.title}</span>
                      <span className="mt-1 block text-xs text-muted-foreground/70">
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
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, borderTop: 1, borderColor: 'divider', px: 1.5, py: 1.5, color: 'text.secondary' }}>
        <Sparkles className="size-3.5" />
        <Typography variant="metadata" component="span">{loginRequired ? '登录后可保存和恢复对话' : '对话自动保存，可随时回来继续'}</Typography>
      </Box>
    </Paper>
  );
}
