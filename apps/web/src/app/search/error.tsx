'use client';

import { RouteErrorState } from '@/components/RouteErrorState';

export default function Error({ reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <RouteErrorState
      title="搜索页面暂时无法打开"
      description="搜索结果加载时遇到问题。重试会保留当前搜索条件。"
      reset={reset}
    />
  );
}
