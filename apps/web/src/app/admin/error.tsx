'use client';

import { RouteErrorState } from '@/components/RouteErrorState';

export default function Error({ reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <RouteErrorState
      title="Admin 页面暂时无法打开"
      description="运营数据或治理模块加载时遇到问题。重试不会提交任何治理操作。"
      reset={reset}
    />
  );
}
