'use client';

import { formatResearchRelativeTime as relativeTime } from '@/lib/ai-research-state';

import React from 'react';
import NextLink from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useQuery } from '@tanstack/react-query';
import { MessageSquare, Plus, Sparkles } from 'lucide-react';

import { AiResearchButton as Button } from '@/components/ai-research/AiResearchMaterial';
import Box from '@mui/material/Box';
import Alert from '@mui/material/Alert';
import Link from '@mui/material/Link';
import Paper from '@mui/material/Paper';
import Skeleton from '@mui/material/Skeleton';
import Typography from '@mui/material/Typography';
import { ErrorState } from '@/components/StateMessage';
import type { AiResearchConversationSummary } from '@/lib/ai-research-chat';
import { friendlyMessage } from '@/lib/errors/friendly';
import { retryOnceAi } from '@/lib/errors/friendly';
import { ApiHttpError, toApiHttpError } from '@/lib/errors/api-error';



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
          <Plus size={16} />
          新建对话
        </Button>
      </Box>
      <Box sx={{ display: 'flex', minHeight: 0, flex: 1, flexDirection: 'column', overflowY: { xs: 'visible', lg: 'auto' }, p: 1 }}>
        <Typography component="span" variant="metadata" sx={{ px: 1, py: 1, fontWeight: 600, letterSpacing: '0.08em', textTransform: 'uppercase', color: 'text.secondary' }}>
          最近对话
        </Typography>
        {query.isLoading ? (
          <Box sx={{ display: 'grid', gap: 1, px: 1 }}>
            {[0, 1, 2].map((i) => (
              <Skeleton key={i} variant="rounded" height={48} />
            ))}
          </Box>
        ) : loginRequired ? (
          <Alert severity="info" action={
            <Button asChild variant="link" size="xs">
              <Link href={`/signin?${new URLSearchParams({ callbackUrl })}`}>登录</Link>
            </Button>
          }>
            登录后查看最近对话。
          </Alert>
        ) : query.isError ? (
          <Box sx={{ mx: 1 }}>
            <ErrorState
              title="对话列表加载失败"
              description={friendlyMessage(query.error, '请稍后重试。')}
              action={
                <Button type="button" size="xs" variant="outline" onClick={() => void query.refetch()}>
                  重试
                </Button>
              }
            />
          </Box>
        ) : query.data?.items.filter((conversation) => conversation.jobId === null).length === 0 ? (
          <Typography component="p" variant="metadata" color="text.secondary" sx={{ px: 1, py: 1 }}>
            还没有未启动的对话。已启动的研究会在“最近任务”中保留。
          </Typography>
        ) : (
          <Box component="ul" sx={{ display: 'grid', gap: 0.5, m: 0, p: 0, listStyle: 'none' }}>
            {query.data?.items.filter((conversation) => conversation.jobId === null).map((conversation) => {
              const active = conversation.id === activeConversationId;
              return (
                <li key={conversation.id}>
                  <Link
                    component={NextLink}
                    href={conversation.jobId ? `/ai-research/${conversation.jobId}` : `/ai-research?conversation=${conversation.id}`}
                    underline="none"
                    sx={{
                      display: 'flex', alignItems: 'flex-start', gap: 1, borderRadius: 1, px: 1.5, py: 1,
                      typography: 'body2', transition: (theme) => theme.transitions.create(['background-color', 'color']),
                      color: active ? 'text.primary' : 'text.secondary',
                      bgcolor: active ? 'action.selected' : 'transparent',
                      '&:hover': { bgcolor: 'action.hover', color: 'text.primary' },
                    }}
                    aria-current={active ? 'page' : undefined}
                  >
                    <Box component={MessageSquare} sx={{ width: 14, height: 14, mt: 0.5, flexShrink: 0 }} aria-hidden />
                    <Box component="span" sx={{ minWidth: 0, flex: 1 }}>
                      <Box component="span" sx={{ display: '-webkit-box', overflow: 'hidden', lineHeight: 1.6, WebkitBoxOrient: 'vertical', WebkitLineClamp: 2 }}>{conversation.title}</Box>
                      <Typography component="span" variant="metadata" sx={{ display: 'block', mt: 0.5, color: 'text.disabled' }}>
                        {relativeTime(conversation.updatedAt)}
                        {conversation.jobId ? ' · 已启动' : ''}
                      </Typography>
                    </Box>
                  </Link>
                </li>
              );
            })}
          </Box>
        )}
      </Box>
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, borderTop: 1, borderColor: 'divider', px: 1.5, py: 1.5, color: 'text.secondary' }}>
        <Sparkles size={14} />
        <Typography variant="metadata" component="span">{loginRequired ? '登录后可保存和恢复对话' : '对话自动保存，可随时回来继续'}</Typography>
      </Box>
    </Paper>
  );
}
