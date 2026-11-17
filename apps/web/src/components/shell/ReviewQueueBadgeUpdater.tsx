'use client';

import { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';

interface Counts {
  total: number;
}

/** Keeps the static shell badge in sync without forcing a full RSC refresh.
 *  The badge's initial number is server-rendered; this only replaces the DOM
 *  text after the first client fetch or a review-queue invalidation.
 */
export function ReviewQueueBadgeUpdater({ initial }: { initial: number }) {
  const [count, setCount] = useState(initial);
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
  }, [data?.total]);

  useEffect(() => {
    document.querySelectorAll('[data-review-queue-badge]').forEach(node => {
      node.textContent = count > 99 ? '99+' : String(count);
      node.setAttribute('aria-label', `待处理：${count} 项待处理`);
    });
  }, [count]);

  return null;
}
