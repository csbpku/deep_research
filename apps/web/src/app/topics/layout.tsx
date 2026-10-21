'use client';

import { Suspense, type ReactNode } from 'react';
import { useSearchParams } from 'next/navigation';

import { LoadingState } from '@/components/StateMessage';
import { parseTopicFilter } from './topic-filter-options';

/** Each server-filtered list is a distinct resource, not stale pending content. */
export default function TopicsLayout({ children }: { children: ReactNode }) {
  const filter = parseTopicFilter(useSearchParams().get('filter'));
  return (
    <Suspense key={filter} fallback={<LoadingState label="正在加载专题…" />}>
      {children}
    </Suspense>
  );
}
