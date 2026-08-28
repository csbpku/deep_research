// Server-only helpers for AI research follow-up chat.

import { prisma } from '@/lib/db';
import { getWebEnv } from '@/lib/env';
import { fetchAiEngine } from '@/lib/ai-bff/fetch-ai-engine';

interface UpstreamJobOut {
  job_id?: string;
  topic?: string | null;
  output_text?: string | null;
  draft_research_id?: string | null;
  report_type?: string | null;
  final_status?: string | null;
  status?: string;
}

/**
 * Load the finished report text that follow-up answers should be grounded in.
 * Priority: upstream output_text → published/draft Research body → empty.
 */
export async function loadResearchReportForJob(
  jobId: string,
  requestId: string,
): Promise<{ title: string; content: string } | null> {
  const job = await prisma.aiResearchJob.findUnique({
    where: { id: jobId },
    select: {
      id: true,
      topic: true,
      outputText: true,
      draftResearchId: true,
      requesterId: true,
    },
  });
  if (!job) return null;

  let content = job.outputText ?? '';

  if (!content && job.draftResearchId) {
    const draft = await prisma.research.findUnique({
      where: { id: job.draftResearchId },
      select: { body: true },
    });
    content = draft?.body ?? '';
  }

  if (!content) {
    const env = getWebEnv();
    const upstream = await fetchAiEngine<UpstreamJobOut>({
      url: `${env.AI_ENGINE_URL.replace(/\/$/u, '')}/api/ai/jobs/${jobId}`,
      requestId,
      context: 'ai.bff.followup.report',
      timeoutMs: 8_000,
      retry: false,
    });
    if (upstream.ok) {
      content = upstream.body.output_text ?? content;
      if (!content && upstream.body.draft_research_id) {
        const draft = await prisma.research.findUnique({
          where: { id: upstream.body.draft_research_id },
          select: { body: true },
        });
        content = draft?.body ?? '';
      }
    }
  }

  return {
    title: job.topic || 'AI 调研',
    content: content.slice(0, 512_000),
  };
}
