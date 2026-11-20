'use client';

import { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';

interface Counts {
  total: number;
  judgementOverdue?: number;
  learningStale?: number;
}

/** Keeps the static shell badge in sync without forcing a full RSC refresh.
 *  The badge's initial number is server-rendered; this only replaces the DOM
 *  text after the first client fetch or a review-queue invalidation.
 */
export function ReviewQueueBadgeUpdater({ initial }: { initial: number }) {
  const [count, setCount] = useState(initial);
  const [overdue, setOverdue] = useState(0);
  const [learningStale, setLearningStale] = useState(0);
  const { data } = useQuery<Counts>({
    queryKey: ['review-queue-count'],
    queryFn: async () => {
      const res = await fetch('/api/review/count');
      if (!res.ok) throw new Error('count failed');
      return res.json();
    },
    staleTime: 30_000,
  });

  useEffect(() => {
    if (typeof data?.total === 'number') setCount(data.total);
    if (typeof data?.judgementOverdue === 'number') setOverdue(data.judgementOverdue);
    if (typeof data?.learningStale === 'number') setLearningStale(data.learningStale);
  }, [data?.total, data?.judgementOverdue, data?.learningStale]);

  useEffect(() => {
    document.querySelectorAll('[data-review-queue-badge]').forEach(node => {
      node.textContent = count > 99 ? '99+' : String(count);
      const hints: string[] = [];
      if (overdue > 0) hints.push(`${overdue} 条判断长期未复核`);
      if (learningStale > 0) hints.push(`${learningStale} 篇学习长期未复习`);
      node.setAttribute('aria-label', hints.length > 0
        ? `待处理：${count} 项，其中 ${hints.join('、')}`
        : `待处理：${count} 项待处理`);
      if (hints.length > 0) node.setAttribute('title', hints.join('、'));
      else node.removeAttribute('title');
    });
  }, [count, overdue, learningStale]);

  return null;
}
