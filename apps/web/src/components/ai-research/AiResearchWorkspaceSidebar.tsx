'use client';

import { AiResearchConversationSidebar } from '@/components/ai-research/AiResearchConversationSidebar';
import { AiResearchTaskHistory } from '@/components/ai-research/AiResearchTaskHistory';
import { RecentResearchArtifacts } from '@/components/ai-research/RecentResearchArtifacts';
import Stack from '@mui/material/Stack';

export function AiResearchWorkspaceSidebar({
  activeConversationId,
  showTaskHistory = false,
  openTaskHistoryOnLoad = false,
  showRecentArtifacts = true,
}: {
  activeConversationId?: string | null;
  showTaskHistory?: boolean;
  openTaskHistoryOnLoad?: boolean;
  showRecentArtifacts?: boolean;
}) {
  return (
    <Stack spacing={2}>
      <AiResearchConversationSidebar activeConversationId={activeConversationId} />
      {showRecentArtifacts ? <RecentResearchArtifacts openTaskHistoryOnLoad={openTaskHistoryOnLoad} /> : null}
      {showTaskHistory ? <AiResearchTaskHistory initialOpen={openTaskHistoryOnLoad} /> : null}
    </Stack>
  );
}
