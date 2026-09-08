// Server-only helpers for AI research follow-up chat.

import { prisma } from '@/lib/db';
import { getWebEnv } from '@/lib/env';
import { fetchAiEngine } from '@/lib/ai-bff/fetch-ai-engine';
import { buildEvidenceDigest, cleanEvidenceSnippet, cleanResearchReportForReader } from '@/lib/research-report';

/**
 * A bounded, reader-visible evidence packet for follow-up questions.
 *
 * The report body is a synthesis.  Follow-up verification needs a separate
 * ledger of the captured passages so the engine can distinguish a claim in
 * the report from the text that can actually support or contradict it.
 */
export interface ResearchEvidencePacket {
  key: string;
  title: string;
  url: string | null;
  excerpt: string;
  capturedAt: string | null;
  sourceType: string;
}

const MAX_FOLLOW_UP_EVIDENCE = 32;
const MAX_FOLLOW_UP_EXCERPT_CHARS = 1_200;

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
): Promise<{ title: string; content: string; evidence: ResearchEvidencePacket[] } | null> {
  const job = await prisma.aiResearchJob.findUnique({
    where: { id: jobId },
    select: {
      id: true,
      topic: true,
      outputText: true,
      draftResearchId: true,
      requesterId: true,
      partialSources: true,
      aiResearchSources: {
        select: { sourceRef: true, canonicalKey: true, title: true, snippet: true, createdAt: true },
        orderBy: { createdAt: 'asc' },
      },
    },
  });
  if (!job) return null;

  let content = '';

  if (job.draftResearchId) {
    const draft = await prisma.research.findUnique({
      where: { id: job.draftResearchId },
      select: { body: true },
    });
    content = draft?.body ?? '';
  }

  if (!content) content = job.outputText ?? '';

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

  // If writing stopped after evidence capture, follow-up questions should
  // still have a grounded, inspectable context. The digest is intentionally
  // read-only and says that it is not a conclusion; it does not invent a
  // report merely to make the chat button available.
  if (!content && job.aiResearchSources.length > 0) {
    content = buildEvidenceDigest(
      job.topic || 'AI 调研',
      job.aiResearchSources.map((source) => ({
        title: source.title || source.canonicalKey,
        snippet: source.snippet,
        href: sourceUrl(source.sourceRef, source.canonicalKey),
        capturedAt: source.createdAt.toISOString(),
      })),
    ) ?? '';
  }

  const evidence = job.aiResearchSources
    .map((source) => toEvidencePacket(source))
    .filter((source): source is ResearchEvidencePacket => source !== null)
    .slice(0, MAX_FOLLOW_UP_EVIDENCE);

  return {
    title: job.topic || 'AI 调研',
    content: cleanResearchReportForReader(
      content.slice(0, 512_000),
      (job.aiResearchSources.length > 0
        ? job.aiResearchSources.map((source) => sourceUrl(source.sourceRef, source.canonicalKey))
        : legacySourceUrls(job.partialSources))
        .filter((href): href is string => href !== null),
    ),
    evidence,
  };
}

function toEvidencePacket(source: {
  sourceRef: unknown;
  canonicalKey: string;
  title: string | null;
  snippet: string | null;
  createdAt: Date;
}): ResearchEvidencePacket | null {
  const excerpt = cleanEvidenceSnippet(source.snippet ?? '', MAX_FOLLOW_UP_EXCERPT_CHARS);
  if (!excerpt) return null;
  return {
    key: source.canonicalKey.slice(0, 512),
    title: (source.title || source.canonicalKey).slice(0, 300),
    url: sourceUrl(source.sourceRef, source.canonicalKey),
    excerpt,
    capturedAt: source.createdAt.toISOString(),
    sourceType: sourceType(source.sourceRef),
  };
}

function legacySourceUrls(value: unknown): Array<string | null> {
  if (!Array.isArray(value)) return [];
  return value.map((item) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return null;
    const row = item as Record<string, unknown>;
    return sourceUrl(row.source_ref, typeof row.canonical_key === 'string' ? row.canonical_key : '');
  });
}

function sourceUrl(value: unknown, canonicalKey: string): string | null {
  let candidate = '';
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const raw = (value as Record<string, unknown>).value;
    if (typeof raw === 'string') candidate = raw;
  }
  if (!candidate && /^https?:\/\//iu.test(canonicalKey)) candidate = canonicalKey;
  try {
    const parsed = new URL(candidate);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:' ? parsed.toString() : null;
  } catch {
    return null;
  }
}

function sourceType(value: unknown): string {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const type = (value as Record<string, unknown>).type;
    if (typeof type === 'string' && type.trim()) return type.trim().slice(0, 32);
  }
  return 'web';
}
