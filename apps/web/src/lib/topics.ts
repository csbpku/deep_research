import { Prisma } from '@prisma/client';

import { prisma } from '@/lib/db';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface TopicCandidateTrendPoint {
  /** YYYY-MM-DD (UTC). */
  date: string;
  count: number;
}

export interface TopicIssueDisplayInput {
  id: string;
  kind: string;
  title: string;
  proposition?: string;
  candidateIds: readonly string[];
  importanceScore: number;
  lastSeenAt: Date | string;
  firstSeenAt?: Date | string;
}

function normalizeIssueTitle(title: string): string {
  return title.toLocaleLowerCase('zh-CN').replace(/[^\p{L}\p{N}]+/gu, '');
}

const ISSUE_TEXT_STOPWORDS = new Set([
  'ai',
  'agent',
  'agents',
  'artificial',
  'intelligence',
  'llm',
  'llms',
  'model',
  'models',
  'system',
  'systems',
  'technology',
  'technologies',
  'tool',
  'tools',
  'new',
  'open',
  'source',
  'the',
  'and',
  'for',
  'with',
  'from',
  'into',
  'that',
  'this',
]);

const ISSUE_CJK_STOP_CONCEPTS = new Set([
  '智能体',
  '基础模型',
  '框架',
  '系统',
  '问题',
  '能力',
  '发布',
  '提出',
  '面向',
  '当前',
  '集中',
  '密集',
  '普遍',
  '受到',
  '引发',
  '关注',
]);

/**
 * Extracts language-neutral concepts from the generated title and proposition.
 * This is intentionally generic: it gives evidence-overlap clustering a
 * conservative text signal without maintaining per-topic title rules.
 */
function issueConcepts(issue: Pick<TopicIssueDisplayInput, 'title' | 'proposition'>): Set<string> {
  const text = `${issue.title} ${issue.proposition ?? ''}`.toLocaleLowerCase('zh-CN');
  const concepts = new Set<string>();

  for (const run of text.matchAll(/[\u4e00-\u9fff]{2,}/gu)) {
    const value = run[0];
    for (let size = 2; size <= 3; size += 1) {
      for (let index = 0; index + size <= value.length; index += 1) {
        const concept = value.slice(index, index + size);
        if (!ISSUE_CJK_STOP_CONCEPTS.has(concept)) concepts.add(concept);
      }
    }
  }

  for (const token of text.match(/[a-z][a-z0-9-]{2,}/g) ?? []) {
    if (!ISSUE_TEXT_STOPWORDS.has(token)) concepts.add(token);
  }
  return concepts;
}

function candidateOverlap(left: readonly string[], right: readonly string[]): number {
  const leftSet = new Set(left);
  const rightSet = new Set(right);
  if (leftSet.size === 0 || rightSet.size === 0) return 0;
  let shared = 0;
  for (const value of leftSet) {
    if (rightSet.has(value)) shared += 1;
  }
  return shared / Math.min(leftSet.size, rightSet.size);
}

function conceptOverlap(
  left: Pick<TopicIssueDisplayInput, 'title' | 'proposition'>,
  right: Pick<TopicIssueDisplayInput, 'title' | 'proposition'>,
): number {
  const leftConcepts = issueConcepts(left);
  const rightConcepts = issueConcepts(right);
  if (leftConcepts.size === 0 || rightConcepts.size === 0) return 0;
  let shared = 0;
  for (const concept of leftConcepts) {
    if (rightConcepts.has(concept)) shared += 1;
  }
  return shared / Math.min(leftConcepts.size, rightConcepts.size);
}

function sameCandidateSet(left: readonly string[], right: readonly string[]): boolean {
  const leftSet = new Set(left);
  const rightSet = new Set(right);
  return leftSet.size > 0
    && leftSet.size === rightSet.size
    && [...leftSet].every((value) => rightSet.has(value));
}

function areNearDuplicateIssues(left: TopicIssueDisplayInput, right: TopicIssueDisplayInput): boolean {
  const overlap = candidateOverlap(left.candidateIds, right.candidateIds);
  if (overlap === 0) return false;
  if (sameCandidateSet(left.candidateIds, right.candidateIds)) return true;
  if (overlap >= 0.8) return true;

  // Shared evidence alone is not enough: one article can support distinct
  // claims. Require a strong shared evidence core and related concepts.
  return overlap >= 2 / 3 && conceptOverlap(left, right) >= 0.08;
}

function toMillis(value: Date | string | undefined): number {
  if (!value) return 0;
  const result = value instanceof Date ? value.getTime() : Date.parse(value);
  return Number.isFinite(result) ? result : 0;
}

/**
 * AI 聚类可能在重复运行时为同一条内容生成多个措辞相近的 issue。
 * 公共专题页不能把这些生成记录当成不同热点，因此：
 * - 同一条内容上的单内容 issue 只保留排序靠前的一条；
 * - 同一组内容上的完全重复 issue 只保留排序靠前的一条；
 * - 候选证据高度重叠且文本概念相关的 issue 合并为一个展示议题；
 * - 其余相同标题 + 类型的记录只保留一条。
 *
 * 合并保留排序靠前的主议题，并把重复记录的证据集合并入主议题。
 */
export function collapseTopicIssues<T extends TopicIssueDisplayInput>(
  issues: readonly T[],
): T[] {
  const parent = issues.map((_, index) => index);
  const find = (index: number): number => {
    let root = index;
    while (parent[root] !== root) root = parent[root];
    while (parent[index] !== index) {
      const next = parent[index];
      parent[index] = root;
      index = next;
    }
    return root;
  };
  const union = (left: number, right: number) => {
    const leftRoot = find(left);
    const rightRoot = find(right);
    if (leftRoot !== rightRoot) parent[rightRoot] = leftRoot;
  };

  const titleIndex = new Map<string, number>();
  for (let index = 0; index < issues.length; index += 1) {
    const issue = issues[index];
    const titleKey = `${issue.kind}:${normalizeIssueTitle(issue.title)}`;
    const previousTitleIndex = titleIndex.get(titleKey);
    if (previousTitleIndex !== undefined) {
      union(previousTitleIndex, index);
      continue;
    }
    titleIndex.set(titleKey, index);
    for (let previous = 0; previous < index; previous += 1) {
      if (areNearDuplicateIssues(issue, issues[previous])) union(previous, index);
    }
  }

  const groups = new Map<number, number[]>();
  for (let index = 0; index < issues.length; index += 1) {
    const root = find(index);
    const members = groups.get(root) ?? [];
    members.push(index);
    groups.set(root, members);
  }

  return [...groups.values()]
    .sort((left, right) => left[0] - right[0])
    .map((members) => {
      const representativeIndex = members.reduce((best, index) => {
        const bestIssue = issues[best];
        const issue = issues[index];
        if (issue.importanceScore > bestIssue.importanceScore) return index;
        if (
          issue.importanceScore === bestIssue.importanceScore
          && toMillis(issue.lastSeenAt) > toMillis(bestIssue.lastSeenAt)
        ) {
          return index;
        }
        return best;
      }, members[0]);
      const representative = issues[representativeIndex];
      const candidateIds = [
        ...new Set(members.flatMap((index) => issues[index].candidateIds)),
      ];
      const firstSeenAt = members
        .map((index) => issues[index].firstSeenAt)
        .filter((value): value is Date | string => value !== undefined)
        .sort((left, right) => toMillis(left) - toMillis(right))[0];
      const lastSeenAt = members
        .map((index) => issues[index].lastSeenAt)
        .sort((left, right) => toMillis(right) - toMillis(left))[0];
      return {
        ...representative,
        candidateIds,
        ...(firstSeenAt === undefined ? {} : { firstSeenAt }),
        lastSeenAt,
      } as T;
    });
}

const MS_PER_DAY = 86_400_000;

/**
 * Pure helper: fill in zero-count days so the sparkline keeps a steady
 * window even when no candidates were linked on certain days.
 */
export function fillTrendDays(
  rows: ReadonlyArray<{ date: string | Date; count: number | bigint }>,
  since: Date,
  days: number,
): TopicCandidateTrendPoint[] {
  const byDay = new Map<string, number>();
  for (const row of rows) {
    const key =
      row.date instanceof Date
        ? row.date.toISOString().slice(0, 10)
        : String(row.date).slice(0, 10);
    byDay.set(key, Number(row.count));
  }
  const start = new Date(since);
  start.setUTCHours(0, 0, 0, 0);
  const series: TopicCandidateTrendPoint[] = [];
  for (let i = 0; i < days; i++) {
    const d = new Date(start.getTime() + i * MS_PER_DAY);
    const key = d.toISOString().slice(0, 10);
    series.push({ date: key, count: byDay.get(key) ?? 0 });
  }
  return series;
}

const DEFAULT_TREND_DAYS = 14;

/**
 * Daily count of new topic_candidates rows for a topic over the trailing
 * `days` window. Used by the topic detail page to draw the trend
 * sparkline. ``addedAt`` is the only signal we have — no separate
 * history table is needed.
 */
export async function loadTopicCandidateTrend(
  topicId: string,
  days: number = DEFAULT_TREND_DAYS,
): Promise<TopicCandidateTrendPoint[]> {
  const since = new Date(Date.now() - days * MS_PER_DAY);
  type TrendRow = { day: Date; count: bigint };
  const rows = await prisma.$queryRaw<TrendRow[]>`
    SELECT date_trunc('day', "addedAt") AS day, COUNT(*) AS count
    FROM "topic_candidates"
    WHERE "topicId" = ${topicId}::uuid AND "addedAt" >= ${since}::timestamptz
    GROUP BY 1
    ORDER BY 1
  `;
  return fillTrendDays(
    rows.map((r) => ({ date: r.day, count: r.count })),
    since,
    days,
  );
}

/** 动态路由可能拿到 URL 编码后的中文 slug，先把编码与解码两种形式都纳入查找。 */
export function topicLookupKeys(key: string): string[] {
  const keys = [key];
  if (key.includes('%')) {
    try {
      const decoded = decodeURIComponent(key);
      if (decoded !== key) keys.push(decoded);
    } catch {
      // 保留原始 key，交给数据库查询
    }
  }
  return keys;
}

/**
 * 主题详情按 slug 路由，但发布流程/后台可能只拿到 topic id。
 * 先按 slug 查，命中不了且参数是 UUID 时再按 id 查，避免 UUID 链接落到 404。
 */
export async function findTopicBySlugOrId<T extends Prisma.TopicSelect>(
  key: string,
  select: T,
): Promise<Prisma.TopicGetPayload<{ select: T }> | null> {
  for (const candidate of topicLookupKeys(key)) {
    const topic = await prisma.topic.findUnique({ where: { slug: candidate }, select });
    if (topic) return topic;
  }
  if (!UUID_RE.test(key)) return null;
  return prisma.topic.findUnique({ where: { id: key }, select });
}
