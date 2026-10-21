'use client';

// 首页"我关注的主题" —— 登录态展示 ≤ 5 个关注的主题。
//
// 数据源：/api/me/topics（仅返回当前用户关注的主题）。
// 该路由内部 requireUser，所以本组件仅在登录态挂载即可。

import Link from 'next/link';
import { useQuery } from '@tanstack/react-query';
import { Flame, Inbox, Pin, Sparkles, TrendingUp, type LucideIcon } from 'lucide-react';
import Box from '@mui/material/Box';
import MaterialLink from '@mui/material/Link';
import Skeleton from '@mui/material/Skeleton';
import Typography from '@mui/material/Typography';
import { space, tokens } from '@deep-research/design-system';

import { SectionCard } from '@/components/domain/SectionCard';
import { StatusBadge } from '@/components/domain/StatusBadge';

interface FollowedTopic {
  followId: string;
  followedAt: string;
  topic: {
    id: string;
    slug: string;
    name: string;
    summary: string | null;
    tier: string;
    candidateCount: number;
    sourceCount: number;
    lastSyncedAt: string | null;
  };
}

interface FollowedTopicsResponse {
  items: FollowedTopic[];
}

const TIER_LABELS: Record<string, { label: string; Icon: LucideIcon }> = {
  hot: { label: '热门', Icon: Flame },
  warming: { label: '升温', Icon: TrendingUp },
  emerging: { label: '新出现', Icon: Sparkles },
};

function formatTimeAgo(iso: string | null): string {
  if (!iso) return '—';
  const ms = Date.now() - new Date(iso).getTime();
  if (ms < 60_000) return '刚刚';
  if (ms < 3_600_000) return `${Math.floor(ms / 60_000)} 分钟前`;
  if (ms < 86_400_000) return `${Math.floor(ms / 3_600_000)} 小时前`;
  return new Date(iso).toLocaleDateString('zh-CN');
}

export function FollowedTopicsStrip() {
  const { data, isLoading } = useQuery<FollowedTopicsResponse>({
    queryKey: ['home', 'followed-topics'],
    queryFn: async () => {
      const r = await fetch('/api/me/topics', { cache: 'no-store' });
      if (!r.ok) throw new Error(`followed topics fetch failed: ${r.status}`);
      return r.json();
    },
    staleTime: 60_000,
    retry: 1,
  });

  const items = data?.items.slice(0, 5) ?? [];

  return (
    <Box sx={{ mt: space.lg }}>
      <SectionCard
        title="我关注的主题"
        icon={Pin}
        actions={
          <MaterialLink component={Link} href="/topics" underline="hover" color="primary.main" variant="metadata">
            全部主题 →
          </MaterialLink>
        }
        bodySpacing="none"
      >
        {isLoading ? (
          <Box sx={{ display: 'grid', gap: space.sm, p: space.md }}>
            {[0, 1, 2].map((i) => (
              <Skeleton key={i} variant="rounded" width="100%" height={48} />
            ))}
          </Box>
        ) : items.length === 0 ? (
          <Box sx={{ display: 'grid', justifyItems: 'center', gap: space.sm, px: space.md, py: space.wide, textAlign: 'center' }}>
            <Box component="span" sx={{ display: 'inline-flex', color: 'text.secondary' }}>
              <Inbox aria-hidden="true" size={24} color="currentColor" />
            </Box>
            <Typography component="h3" variant="fieldTitle">还没有关注任何主题</Typography>
            <Typography variant="body2" color="text.secondary">在主题页点击「关注」即可在此显示。</Typography>
            <MaterialLink component={Link} href="/topics" underline="hover" color="primary.main" variant="body2">
              浏览主题 →
            </MaterialLink>
          </Box>
        ) : (
          <Box component="ul" sx={{ listStyle: 'none', m: 0, p: 0 }}>
            {items.map(({ topic }, index) => {
              const tier = TIER_LABELS[topic.tier] ?? TIER_LABELS.emerging;
              const Icon = tier.Icon;
              return (
                <Box component="li" key={topic.id} sx={{ minWidth: 0 }}>
                  <Box
                    component={Link}
                    href={`/topics/${topic.slug}`}
                    sx={{
                      display: 'flex', alignItems: { xs: 'flex-start', sm: 'center' }, gap: space.md,
                      minWidth: 0, px: space.md, py: space.sm, color: 'inherit', textDecoration: 'none',
                      borderBottom: index < items.length - 1 ? 1 : 0, borderColor: 'divider',
                      transition: `background-color ${tokens['motion-fast']}`,
                      '&:hover': { bgcolor: 'action.hover' },
                      '&:hover h3': { color: 'primary.main' },
                    }}
                  >
                    <StatusBadge kind="topicTier" value={topic.tier} label={tier.label} icon={<Icon aria-hidden="true" />} />
                    <Box sx={{ minWidth: 0, flex: 1 }}>
                      <Typography component="h3" variant="listTitle" noWrap sx={{ transition: `color ${tokens['motion-fast']}` }}>
                        {topic.name}
                      </Typography>
                      {topic.summary ? (
                        <Typography variant="metadata" color="text.secondary" sx={{ mt: space.xs, display: '-webkit-box', overflow: 'hidden', WebkitBoxOrient: 'vertical', WebkitLineClamp: 1 }}>
                          {topic.summary}
                        </Typography>
                      ) : null}
                      <Typography variant="metadata" color="text.secondary" sx={{ mt: space.xs, fontVariantNumeric: 'tabular-nums' }}>
                        {topic.candidateCount} 条相关内容 · {topic.sourceCount} 个采集渠道
                        {topic.lastSyncedAt ? ` · 更新 ${formatTimeAgo(topic.lastSyncedAt)}` : null}
                      </Typography>
                    </Box>
                  </Box>
                </Box>
              );
            })}
          </Box>
        )}
      </SectionCard>
    </Box>
  );
}
