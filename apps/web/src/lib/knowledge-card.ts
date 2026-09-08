import { prisma } from '@/lib/db';

export const KNOWLEDGE_SOURCE_KINDS = ['research_chat', 'radar_chat'] as const;
export type KnowledgeSourceKind = (typeof KNOWLEDGE_SOURCE_KINDS)[number];

export interface KnowledgeCardSource {
  sourceRef: Record<string, unknown>;
  canonicalKey: string;
  title: string | null;
  description: string | null;
}

export interface ResolvedKnowledgeSource {
  messageId: string;
  content: string;
  topic: string;
  sources: KnowledgeCardSource[];
}

const HTTP_URL_RE = /^https?:\/\/\S+$/iu;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function asHttpUrl(value: unknown): string | null {
  if (typeof value !== 'string' || !HTTP_URL_RE.test(value.trim())) return null;
  try {
    const url = new URL(value.trim());
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.toString() : null;
  } catch {
    return null;
  }
}

function addSource(
  sources: KnowledgeCardSource[],
  source: KnowledgeCardSource,
): void {
  const key = source.canonicalKey.trim();
  if (!key || sources.some((item) => item.canonicalKey === key)) return;
  sources.push({ ...source, canonicalKey: key });
}

export async function resolveKnowledgeSource(
  kind: KnowledgeSourceKind,
  messageId: string,
  userId: string,
): Promise<ResolvedKnowledgeSource | null> {
  if (kind === 'research_chat') {
    const message = await prisma.aiResearchConversationMessage.findUnique({
      where: { id: messageId },
      select: {
        id: true,
        role: true,
        content: true,
        conversation: {
          select: {
            userId: true,
            title: true,
            jobId: true,
            job: {
              select: {
                topic: true,
                aiResearchSources: {
                  orderBy: { createdAt: 'asc' },
                  select: {
                    sourceRef: true,
                    canonicalKey: true,
                    title: true,
                    snippet: true,
                  },
                },
              },
            },
          },
        },
      },
    });
    if (
      !message
      || message.role !== 'assistant'
      || message.conversation.userId !== userId
      || !message.content.trim()
    ) {
      return null;
    }

    const sources: KnowledgeCardSource[] = [];
    for (const source of message.conversation.job?.aiResearchSources ?? []) {
      addSource(sources, {
        sourceRef: isRecord(source.sourceRef)
          ? source.sourceRef
          : { type: 'url', value: source.canonicalKey },
        canonicalKey: source.canonicalKey,
        title: source.title,
        description: source.snippet,
      });
    }
    return {
      messageId: message.id,
      content: message.content.slice(0, 256000),
      topic: message.conversation.job?.topic ?? message.conversation.title,
      sources,
    };
  }

  const message = await prisma.aiChatMessage.findUnique({
    where: { id: messageId },
    select: {
      id: true,
      role: true,
      content: true,
      sourcesJson: true,
      session: {
        select: {
          userId: true,
          seedSnapshot: true,
        },
      },
    },
  });
  if (
    !message
    || message.role !== 'assistant'
    || message.session.userId !== userId
    || !message.content.trim()
  ) {
    return null;
  }

  const snapshot = isRecord(message.session.seedSnapshot)
    ? message.session.seedSnapshot
    : {};
  const sources: KnowledgeCardSource[] = [];
  const seedUrl = asHttpUrl(snapshot.url);
  if (seedUrl) {
    addSource(sources, {
      sourceRef: { type: 'url', value: seedUrl },
      canonicalKey: seedUrl,
      title: typeof snapshot.title === 'string' ? snapshot.title : null,
      description: typeof snapshot.interpretation === 'string' ? snapshot.interpretation : null,
    });
  }

  if (Array.isArray(message.sourcesJson)) {
    for (const raw of message.sourcesJson) {
      if (!isRecord(raw)) continue;
      const url = asHttpUrl(raw.sourceUrl ?? raw.url);
      if (!url) continue;
      addSource(sources, {
        sourceRef: { type: 'url', value: url },
        canonicalKey: url,
        title: typeof raw.title === 'string' ? raw.title : null,
        description: typeof raw.quote === 'string'
          ? raw.quote
          : typeof raw.snippet === 'string'
            ? raw.snippet
            : null,
      });
    }
  }

  return {
    messageId: message.id,
    content: message.content.slice(0, 256000),
    topic: typeof snapshot.title === 'string' && snapshot.title.trim()
      ? snapshot.title
      : '雷达文章',
    sources,
  };
}
