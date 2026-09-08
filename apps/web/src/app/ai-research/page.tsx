'use client';

// /ai-research —— 对话式调研工作台。
//
// 研究任务的历史仍然存在，但默认只呈现最近任务；完整筛选和重跑入口
// 收在 AiResearchTaskHistory 的抽屉中，避免新建研究时被一张历史表打断。

import { Suspense } from 'react';
import { useSearchParams } from 'next/navigation';

import { AiResearchConversation } from '@/components/ai-research/AiResearchConversation';
import { AiResearchWorkspaceSidebar } from '@/components/ai-research/AiResearchWorkspaceSidebar';
import { PageHeader } from '@/components/domain/PageHeader';
import { Skeleton } from '@/components/ui/skeleton';

function AiResearchPageClient() {
  const searchParams = useSearchParams();
  const conversationId = searchParams.get('conversation');
  const historyOpen = searchParams.get('history') === '1';

  return (
    <div className="mx-auto max-w-shell">
      <PageHeader
        variant="workbench"
        title="AI 调研"
        description="把一个需要判断的问题交给 AI。先确认问题和资料，再观察证据，最后得到可继续追问的研究结果。"
      />
      <div className="grid items-start gap-6 lg:grid-cols-[280px_minmax(0,1fr)]">
        <div className="order-1 min-w-0 lg:order-2">
          <AiResearchConversation conversationId={conversationId} />
        </div>
        <div className="order-2 lg:order-1">
          <AiResearchWorkspaceSidebar
            activeConversationId={conversationId}
            openTaskHistoryOnLoad={historyOpen}
          />
        </div>
      </div>
    </div>
  );
}

export default function AiResearchPage() {
  return (
    <Suspense
      fallback={
        <div className="mx-auto max-w-shell space-y-2">
          <Skeleton className="h-8 w-40" />
          <Skeleton className="h-32 w-full max-w-2xl" />
        </div>
      }
    >
      <AiResearchPageClient />
    </Suspense>
  );
}
