'use client';

import { RouteErrorState } from '@/components/RouteErrorState';

export default function Error({ reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <RouteErrorState
      title="研究库页面暂时无法打开"
      description="研究列表或研究详情加载时遇到问题。可以重试当前页面，或回到工作台。"
      reset={reset}
    />
  );
}
