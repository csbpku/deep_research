'use client';

// /topics 顶部筛选芯片（ADR 0010）。
// 客户端组件：把当前 filter 高亮，点击切换 URL；不参与数据加载。

import Link from 'next/link';
import { usePathname, useSearchParams } from 'next/navigation';
import { Compass, Flame, Sparkles, Star, TrendingUp } from 'lucide-react';

import { AppButton } from '@/components/material/AppButton';
import { LinkPendingIcon } from '@/components/material/LinkPendingIcon';
import { parseTopicFilter, type TopicFilterKey } from './topic-filter-options';
import styles from './topics.module.css';

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
  const current = parseTopicFilter(params.get('filter'));

  return (
    <nav className={styles.filters} aria-label="专题筛选">
      {TOPICS_FILTERS.map(({ key, label, Icon }) => {
        const active = current === key;
        const unread = key === 'followed' ? unreadByFilter[key] : undefined;
        const href = key === 'all' ? pathname : `${pathname}?filter=${key}`;
        return (
          <AppButton component={Link}
            key={key}
            href={href}
            aria-current={active ? 'page' : undefined}
            variant="outlined"
            className={styles.filter}
            startIcon={<LinkPendingIcon label={label}><Icon aria-hidden /></LinkPendingIcon>}
            sx={{ color: active ? 'primary.main' : 'text.secondary', bgcolor: active ? 'action.selected' : 'background.paper', borderColor: active ? 'primary.main' : 'divider' }}
          >
            {label}
            {unread && unread > 0 ? (
              <span className={styles.unreadCount} aria-label={`${unread} 个新议题`}>
                {unread}
              </span>
            ) : null}
          </AppButton>
        );
      })}
    </nav>
  );
}
