'use client';

import { AiResearchConversationSidebar } from '@/components/ai-research/AiResearchConversationSidebar';
import { AiResearchTaskHistory } from '@/components/ai-research/AiResearchTaskHistory';
import { RecentResearchArtifacts } from '@/components/ai-research/RecentResearchArtifacts';

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
    <div className="space-y-4">
      <AiResearchConversationSidebar activeConversationId={activeConversationId} />
      {showRecentArtifacts ? <RecentResearchArtifacts openTaskHistoryOnLoad={openTaskHistoryOnLoad} /> : null}
      {showTaskHistory ? <AiResearchTaskHistory initialOpen={openTaskHistoryOnLoad} /> : null}
    </div>
  );
}
