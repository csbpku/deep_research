'use client';

import { RouteErrorState } from '@/components/RouteErrorState';

export default function Error({ reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <RouteErrorState
      title="AI 调研页面暂时无法打开"
      description="研究任务或结果加载时遇到问题。重试不会创建新任务，也不会修改已有研究。"
      reset={reset}
    />
  );
}
