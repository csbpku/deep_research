// Server-only helpers for AI research follow-up chat.

import { prisma } from '@/lib/db';
import { getWebEnv } from '@/lib/env';
import { fetchAiEngine } from '@/lib/ai-bff/fetch-ai-engine';
import { buildEvidenceDigest, cleanResearchReportForReader } from '@/lib/research-report';
import { matchingCapturedSnapshot } from '@/lib/research-source-snapshot';

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
const MAX_FOLLOW_UP_EXCERPT_CHARS = 12_000;
const MAX_FOLLOW_UP_EVIDENCE_CHARS = 120_000;

interface EvidenceSource {
  sourceRef: unknown;
  canonicalKey: string;
  title: string | null;
  snippet: string | null;
  createdAt: Date;
}

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
  // A linked draft's ledger is authoritative, including an empty ledger.
  let draftSources: EvidenceSource[] | null = job.draftResearchId ? [] : null;

  if (job.draftResearchId) {
    const draft = await prisma.research.findUnique({
      where: { id: job.draftResearchId },
      select: { body: true, researchSources: { select: { sourceRef: true, canonicalKey: true, title: true, description: true, createdAt: true }, orderBy: { createdAt: 'asc' } } },
    });
    content = draft?.body ?? '';
    draftSources = draft?.researchSources?.map((source) => ({ ...source, snippet: source.description })) ?? [];
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
          select: { body: true, researchSources: { select: { sourceRef: true, canonicalKey: true, title: true, description: true, createdAt: true }, orderBy: { createdAt: 'asc' } } },
        });
        content = draft?.body ?? '';
        draftSources = draft?.researchSources?.map((source) => ({ ...source, snippet: source.description })) ?? [];
      }
    }
  }

  const previewLimit = draftSources === null ? 2000 : 1000;
  const sourceRows = draftSources ?? job.aiResearchSources;
  const resolvedSources = sourceRows.map((source) => {
    const match = matchingCapturedSnapshot([{ canonicalKey: source.canonicalKey, sourceRef: source.sourceRef,
      title: source.title, description: source.snippet }], job.partialSources, previewLimit);
    return { ...source, snippet: match?.[0]?.snippet ?? source.snippet };
  });

  // A failed writer may leave a useful evidence-only snapshot.
  if (!content && resolvedSources.length > 0) {
    content = buildEvidenceDigest(job.topic || 'AI 调研', resolvedSources.map((source) => ({
      title: source.title || source.canonicalKey,
      snippet: source.snippet,
      href: sourceUrl(source.sourceRef, source.canonicalKey),
      capturedAt: source.createdAt.toISOString(),
    }))) ?? '';
  }

  const usable = resolvedSources
    .filter((source) => Boolean(source.snippet?.trim()))
    .slice(0, MAX_FOLLOW_UP_EVIDENCE);
  const perSource = Math.min(MAX_FOLLOW_UP_EXCERPT_CHARS,
    Math.floor(MAX_FOLLOW_UP_EVIDENCE_CHARS / Math.max(1, usable.length)));
  const evidence = usable.map((source) => toEvidencePacket(source, perSource))
    .filter((source): source is ResearchEvidencePacket => source !== null);
  return {
    title: job.topic || 'AI 调研',
    content: cleanResearchReportForReader(
      content.slice(0, 512_000),
      (draftSources !== null || job.aiResearchSources.length > 0
        ? resolvedSources.map((source) => sourceUrl(source.sourceRef, source.canonicalKey))
        : legacySourceUrls(job.partialSources))
        .filter((href): href is string => href !== null),
    ),
    evidence,
  };
}

// Preserve underscores in API identifiers such as return_exceptions. This
// text remains explicitly untrusted when it enters the research chat prompt.
function cleanFollowUpEvidence(value: string): string {
  return value
    .replace(/!\[([^\]]*)\]\([^)]*\)/gu, '$1')
    .replace(/\[([^\]]+)\]\([^)]*\)/gu, '$1')
    .replace(/<[^>]+>/gu, ' ')
    .replace(/^\s{0,3}#{1,6}\s*/gmu, '')
    .replace(/\*\*([^*\n]+)\*\*/gu, '$1')
    .replace(/\s+/gu, ' ')
    .trim();
}

function toEvidencePacket(source: EvidenceSource, limit: number): ResearchEvidencePacket | null {
  const clean = cleanFollowUpEvidence(source.snippet ?? '');
  const excerpt = Array.from(clean).slice(0, limit).join('');
  if (!excerpt) return null;
  return {
    key: Array.from(source.canonicalKey).slice(0, 512).join(''),
    title: Array.from(source.title || source.canonicalKey).slice(0, 300).join(''),
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
