import type { Prisma } from '@prisma/client';

import { prisma } from '@/lib/db';

export const PERSONAL_CONTEXT_LIMITS = {
  query: 2000,
  keywords: 16,
  candidates: 24,
  results: 12,
} as const;

const STOP_WORDS = new Set((
  'a an and are as at be by can could do does for from how i in is it of on or our should that the this to use we what when whether which with would you your research compare evaluate investigate explain ' +
  '我们 我 你 你们 是否 如何 怎么 什么 哪些 为什么 可以 需要 应该 进行 相关 关于 以及 还是 目前 当前 一个 一些 这个 这些 那个 的 了 和 与 在 对 是 有 吗 呢 请 帮 帮我 想 要 做 调研 研究 分析 评估 比较 对比 了解'
).split(/\s+/u));

const segmenter = new Intl.Segmenter('zh', { granularity: 'word' });

/** Bounded word segmentation, not a full-sentence title substring or an embedding. */
export function extractPersonalContextKeywords(question: string): string[] {
  const text = question.slice(0, PERSONAL_CONTEXT_LIMITS.query).normalize('NFKC').toLowerCase();
  const keywords = new Set<string>();
  const add = (word: string) => {
    if (word.length >= 2 && word.length <= 64 && !STOP_WORDS.has(word) && !/^\d+$/u.test(word)) {
      keywords.add(word);
    }
  };
  for (const part of text.matchAll(/[a-z][a-z0-9]*(?:[.+#_-][a-z0-9]+)*|[\p{Script=Han}]+/gu)) {
    if (/^[a-z]/u.test(part[0])) {
      add(part[0]);
    } else {
      for (const word of segmenter.segment(part[0])) {
        if (word.isWordLike) add(word.segment);
        if (keywords.size >= PERSONAL_CONTEXT_LIMITS.keywords) break;
      }
    }
    if (keywords.size >= PERSONAL_CONTEXT_LIMITS.keywords) break;
  }
  return Array.from(keywords).slice(0, PERSONAL_CONTEXT_LIMITS.keywords);
}

export function personalContextTextScore(
  keywords: readonly string[],
  fields: { title?: string | null; conclusion?: string | null; body?: string | null; background?: string | null; knowledgeIndexText?: string | null },
): number {
  const title = (fields.title ?? '').slice(0, 300).toLowerCase();
  const judgment = `${(fields.knowledgeIndexText ?? '').slice(0, 2000)} ${(fields.conclusion ?? '').slice(0, 2000)}`.toLowerCase();
  const content = `${(fields.background ?? '').slice(0, 2000)} ${(fields.body ?? '').slice(0, 6000)}`.toLowerCase();
  return keywords.slice(0, PERSONAL_CONTEXT_LIMITS.keywords).reduce((score, keyword) => (
    score + (title.includes(keyword) ? 4 : 0) + (judgment.includes(keyword) ? 3 : 0) + (content.includes(keyword) ? 1 : 0)
  ), 0);
}

export interface PersonalContextSuggestion {
  kind: 'knowledge' | 'research';
  id: string;
  title: string;
  snippet: string;
  private: boolean;
  confirmedKnowledge: boolean;
  isExcerpt: boolean;
  topicMatch: boolean;
  status: string;
  updatedAt: string;
  sourceRefs: Array<{ type: 'research'; value: string; required: false }>;
}

export async function findPersonalContext(
  userId: string,
  question: string,
  topicIds: readonly string[] = [],
  includePublished = false,
): Promise<PersonalContextSuggestion[]> {
  const keywords = extractPersonalContextKeywords(question);
  const boundedTopicIds = Array.from(new Set(topicIds)).slice(0, 4);
  if (!keywords.length && !boundedTopicIds.length) return [];

  const matches: Prisma.ResearchWhereInput[] = keywords.flatMap((keyword) => [
    { title: { contains: keyword, mode: 'insensitive' as const } },
    { conclusion: { contains: keyword, mode: 'insensitive' as const } },
    { knowledgeIndexText: { contains: keyword, mode: 'insensitive' as const } },
    { background: { contains: keyword, mode: 'insensitive' as const } },
    { body: { contains: keyword, mode: 'insensitive' as const } },
  ]);
  if (boundedTopicIds.length) matches.push({ researchTopics: { some: { topicId: { in: boundedTopicIds } } } });

  const select = {
    id: true, title: true, type: true, status: true, authorId: true,
    body: true, background: true, conclusion: true, knowledgeIndexText: true, updatedAt: true,
    researchTopics: { where: { topicId: { in: boundedTopicIds } }, take: 4, select: { topicId: true } },
  } satisfies Prisma.ResearchSelect;
  const [confirmed, other] = await Promise.all([
    prisma.research.findMany({
      where: {
        authorId: userId, type: 'knowledge', status: { in: ['draft', 'published'] },
        knowledgeIndexText: { not: null }, OR: matches,
      },
      select, orderBy: { updatedAt: 'desc' }, take: PERSONAL_CONTEXT_LIMITS.candidates,
    }),
    prisma.research.findMany({
      where: {
        type: { in: includePublished ? ['research', 'knowledge'] : ['research'] },
        NOT: { authorId: userId, type: 'knowledge', knowledgeIndexText: { not: null } },
        AND: [
          { OR: [
            { authorId: userId, status: { in: ['draft', 'published'] } },
            ...(includePublished ? [{ status: 'published' as const }] : []),
          ] },
          { OR: matches },
        ],
      },
      select, orderBy: { updatedAt: 'desc' }, take: PERSONAL_CONTEXT_LIMITS.candidates,
    }),
  ]);
  const unique = new Map([...confirmed, ...other].map((row) => [row.id, row]));
  return Array.from(unique.values())
    .filter((row) => (
      (row.status === 'draft' || row.status === 'published')
      && (row.authorId === userId || (includePublished && row.status === 'published'))
      && (includePublished || row.type === 'research' || (row.type === 'knowledge' && row.knowledgeIndexText !== null))
    ))
    .map((row) => {
      const own = row.authorId === userId;
      const confirmedKnowledge = own && row.type === 'knowledge' && row.knowledgeIndexText !== null;
      const topicMatch = row.researchTopics.some((topic) => boundedTopicIds.includes(topic.topicId));
      const relevance = personalContextTextScore(keywords, row) + (topicMatch ? 8 : 0);
      const priority = confirmedKnowledge ? 3 : own && row.type === 'research' ? 2 : own ? 1 : 0;
      return { row, confirmedKnowledge, topicMatch, relevance, priority };
    })
    .filter(({ relevance }) => relevance > 0)
    .sort((a, b) => (
      b.priority - a.priority || b.relevance - a.relevance
      || b.row.updatedAt.getTime() - a.row.updatedAt.getTime() || a.row.id.localeCompare(b.row.id)
    ))
    .slice(0, PERSONAL_CONTEXT_LIMITS.results)
    .map(({ row, confirmedKnowledge, topicMatch }) => ({
      kind: row.type === 'knowledge' ? 'knowledge' : 'research',
      id: row.id,
      title: row.title,
      snippet: (confirmedKnowledge ? row.knowledgeIndexText! : row.conclusion || row.background || row.body).slice(0, 240),
      private: row.status !== 'published',
      confirmedKnowledge,
      isExcerpt: row.type === 'knowledge' && row.knowledgeIndexText === null,
      topicMatch,
      status: row.status,
      updatedAt: row.updatedAt.toISOString(),
      sourceRefs: [{ type: 'research', value: row.id, required: false }],
    }));
}
