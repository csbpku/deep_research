'use client';

// /topics 顶部筛选芯片（ADR 0010）。
// 客户端组件：把当前 filter 高亮，点击切换 URL；不参与数据加载。

import Link from 'next/link';
import { usePathname, useSearchParams } from 'next/navigation';
import { Compass, Flame, Sparkles, Star, TrendingUp } from 'lucide-react';

import { cn } from '@/lib/utils';
import { Badge } from '@/components/ui/badge';
import { type TopicFilterKey } from './topic-filter-options';

export const TOPICS_FILTERS = [
  { key: 'all', label: '全部专题', Icon: Compass },
  { key: 'hot', label: '热门', Icon: Flame },
  { key: 'warming', label: '升温', Icon: TrendingUp },
  { key: 'emerging', label: '新出现', Icon: Sparkles },
  { key: 'followed', label: '只看已关注', Icon: Star },
] as const;

interface Props {
  unreadByFilter: Partial<Record<TopicFilterKey, number>>;
}

export function TopicsFilter({ unreadByFilter }: Props) {
  const pathname = usePathname();
  const params = useSearchParams();
  const current = (params.get('filter') ?? 'all') as TopicFilterKey;

  return (
    <nav className="mb-3 flex flex-wrap items-center gap-2" aria-label="专题筛选">
      {TOPICS_FILTERS.map(({ key, label, Icon }) => {
        const active = current === key;
        const unread = key === 'followed' ? unreadByFilter[key] : undefined;
        const href = key === 'all' ? pathname : `${pathname}?filter=${key}`;
        return (
          <Link
            key={key}
            href={href}
            aria-current={active ? 'page' : undefined}
            className={cn(
              // 移动端使用 44px 触控目标，桌面端收紧到 36px。
              'inline-flex h-11 min-h-11 items-center gap-1.5 rounded-full border px-3 text-xs font-medium transition-colors sm:h-9 sm:min-h-9',
              active
                ? 'border-primary bg-primary/10 text-primary'
                : 'border-border bg-card text-foreground/80 hover:text-foreground hover:border-foreground/30',
              'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background',
            )}
          >
            <Icon className="size-3.5" />
            {label}
            {unread && unread > 0 ? (
              <Badge className="bg-primary/20 text-primary">
                {unread}
              </Badge>
            ) : null}
          </Link>
        );
      })}
    </nav>
  );
}
