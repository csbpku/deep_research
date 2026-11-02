'use client';

// /ai-research —— 对话式调研工作台。
//
// 研究任务的历史仍然存在，但默认只呈现最近任务；完整筛选和重跑入口
// 收在 AiResearchTaskHistory 的抽屉中，避免新建研究时被一张历史表打断。

import { Suspense } from 'react';
import { useSearchParams } from 'next/navigation';

import { AiResearchConversation } from '@/components/ai-research/AiResearchConversation';
import { AiResearchWorkspaceSidebar } from '@/components/ai-research/AiResearchWorkspaceSidebar';
import Box from '@mui/material/Box';
import Skeleton from '@mui/material/Skeleton';
import { PageHeader } from '@/components/domain/PageHeader';

function AiResearchPageClient() {
  const searchParams = useSearchParams();
  const conversationId = searchParams.get('conversation');
  const historyOpen = searchParams.get('history') === '1';
  const fromJobId = searchParams.get('fromJob');
  const jobId = searchParams.get('job');

  return (
    <Box className="material-surface" sx={{ width: '100%', maxWidth: 'var(--dr-width-shell)', mx: 'auto' }}>
      <PageHeader
        variant="workbench"
        title="AI 调研"
        description="把一个需要判断的问题交给 AI。先确认问题和资料，再观察证据，最后得到可继续追问的研究结果。"
      />
      <Box sx={{ display: 'grid', alignItems: 'start', gap: 3, gridTemplateColumns: { xs: 'minmax(0, 1fr)', lg: '280px minmax(0, 1fr)' } }}>
        <Box sx={{ order: { xs: 1, lg: 2 }, minWidth: 0 }}>
          <AiResearchConversation conversationId={conversationId} fromJobId={fromJobId} jobId={jobId} />
        </Box>
        <Box sx={{ order: { xs: 2, lg: 1 }, minWidth: 0 }}>
          <AiResearchWorkspaceSidebar
            activeConversationId={conversationId}
            openTaskHistoryOnLoad={historyOpen}
          />
        </Box>
      </Box>
    </Box>
  );
}

export default function AiResearchPage() {
  return (
    <Suspense
      fallback={
        <Box className="material-surface" sx={{ width: '100%', maxWidth: 'var(--dr-width-shell)', mx: 'auto', display: 'grid', gap: 1 }}>
          <Skeleton variant="text" width={160} height={36} />
          <Skeleton variant="rounded" width="100%" sx={{ maxWidth: 672, height: 128 }} />
        </Box>
      }
    >
      <AiResearchPageClient />
    </Suspense>
  );
}
