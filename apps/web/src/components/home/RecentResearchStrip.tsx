'use client';

// 首页"研究库精选" —— 登录态展示已发布的研究/知识卡片 2x2 缩略图。
//
// 数据源：复用 /api/researches?scope=published&limit=4（不传 type 同时拿 research + knowledge，
// 已在 researchListWhere 里实现 type 可选过滤）。该路由内部 requireUser，
// 所以本组件仅在登录态挂载即可。

import Link from 'next/link';
import { useQuery } from '@tanstack/react-query';
import { Library, Star } from 'lucide-react';
import Box from '@mui/material/Box';
import MaterialLink from '@mui/material/Link';
import Skeleton from '@mui/material/Skeleton';
import Typography from '@mui/material/Typography';
import { space, tokens } from '@deep-research/design-system';

import { SectionCard } from '@/components/domain/SectionCard';
import { StatusBadge } from '@/components/domain/StatusBadge';
import { TagChip, TagList } from '@/components/domain/TagChip';

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
    <Box sx={{ mt: space.lg }}>
      <SectionCard
        title="研究库精选"
        icon={Library}
        actions={
          <MaterialLink component={Link} href="/researches" underline="hover" color="primary.main" variant="metadata">
            查看全部 →
          </MaterialLink>
        }
      >
        {isLoading ? (
          <Box sx={{ display: 'grid', gridTemplateColumns: { xs: 'minmax(0, 1fr)', md: 'repeat(2, minmax(0, 1fr))' }, gap: space.md }}>
            {[0, 1, 2, 3].map((i) => (
              <Skeleton key={i} variant="rounded" width="100%" height={96} />
            ))}
          </Box>
        ) : (
          <Box component="ul" sx={{ display: 'grid', gridTemplateColumns: { xs: 'minmax(0, 1fr)', md: 'repeat(2, minmax(0, 1fr))' }, gap: space.md, listStyle: 'none', m: 0, p: 0 }}>
            {items.map((item) => (
              <Box component="li" key={item.id} sx={{ minWidth: 0 }}>
                <MaterialLink
                  component={Link}
                  href={`/researches/${item.id}`}
                  underline="none"
                  color="inherit"
                  sx={{
                    display: 'flex', height: '100%', minWidth: 0, flexDirection: 'column', gap: space.sm,
                    border: 1, borderColor: 'divider', borderRadius: tokens['radius-small'], bgcolor: 'background.paper', p: space.md,
                    transition: `transform ${tokens['motion-fast']}, border-color ${tokens['motion-fast']}, box-shadow ${tokens['motion-fast']}`,
                    '&:hover': { transform: 'translateY(-1px)', borderColor: 'primary.main', boxShadow: 1 },
                    '&:hover h3': { color: 'primary.main' },
                    '&:focus-visible': { outline: '2px solid', outlineColor: 'primary.main', outlineOffset: '2px' },
                  }}
                >
                  <Box sx={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: space.xs }}>
                    <StatusBadge kind="method" value={item.creationMethod} />
                    {item.featuredAt ? (
                      <StatusBadge kind="featured" value="true" icon={<Star aria-hidden="true" />} />
                    ) : null}
                  </Box>
                  <Typography component="h3" variant="listTitle" sx={{ display: '-webkit-box', overflow: 'hidden', WebkitBoxOrient: 'vertical', WebkitLineClamp: 2, transition: `color ${tokens['motion-fast']}` }}>
                    {item.title}
                  </Typography>
                  <Typography variant="metadata" color="text.secondary" sx={{ display: '-webkit-box', overflow: 'hidden', WebkitBoxOrient: 'vertical', WebkitLineClamp: 2 }}>
                    {excerpt(item.body, 140)}
                  </Typography>
                  {item.tags.length > 0 ? (
                    <TagList style={{ marginTop: 'auto' }}>
                      {item.tags.slice(0, 2).map((t) => (
                        <TagChip key={t}>{t}</TagChip>
                      ))}
                      {item.tags.length > 2 ? (
                        <Typography variant="metadata" color="text.secondary" sx={{ fontVariantNumeric: 'tabular-nums' }}>
                          +{item.tags.length - 2}
                        </Typography>
                      ) : null}
                    </TagList>
                  ) : null}
                  <Box sx={{ display: 'flex', alignItems: 'center', gap: space.sm, minWidth: 0, color: 'text.secondary' }}>
                    <Typography variant="metadata" noWrap sx={{ minWidth: 0, flex: 1, color: 'inherit' }}>{item.author.name}</Typography>
                    <Typography component="span" variant="metadata" aria-hidden="true" sx={{ color: 'inherit' }}>·</Typography>
                    <Typography component="span" variant="metadata" sx={{ flexShrink: 0, color: 'inherit', fontVariantNumeric: 'tabular-nums' }}>
                      {formatTimeAgo(item.publishedAt ?? item.createdAt)}
                    </Typography>
                  </Box>
                </MaterialLink>
              </Box>
            ))}
          </Box>
        )}
      </SectionCard>
    </Box>
  );
}
