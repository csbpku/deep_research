// 雷达共享 helper —— 把 summary 行为规整到 列表 / 详情 响应。
//
// 雷达候选存储在 summaries 表：自动雷达条目 + 已审核用户分享。
// 这里的 helper 负责：
//   1. 从 Prisma 行抽取雷达字段
//   2. 规范化日期格式
//   3. 组装候选 + 当前用户反馈 + 计数

import type { RadarFeedbackType } from '@deep-research/shared/states';
import {
  DistilledScoreSchema,
  type DistilledScore,
} from '@deep-research/shared/schemas';

export type RadarFeedbackCount = {
  useful: number;
  inaccurate: number;
  used: number;
  favorite: number;
  suggest_research: number;
};

export const RADAR_FEEDBACK_TYPES = [
  'useful',
  'inaccurate',
  'used',
  'favorite',
  'suggest_research',
] as const satisfies readonly RadarFeedbackType[];

export type RadarCandidateShape = {
  id: string;
  title: string;
  excerpt: string;
  body: string | null;
  url: string;
  sourceType: string | null;
  syncRunId: string | null;
  syncDate: string | null;
  tags: string[];
  status: string;
  publishedAt: string | null;
  crawledAt: string;
  interpretation: string | null;
  scoreReason: string | null;
  scoreVersion: string | null;
  relevanceScore: number | null;
  timelinessScore: number | null;
  sourceQualityScore: number | null;
  distilledScore: DistilledScore | null;
  summaryDate: string;
  selectionReason: string | null;
  sortOrder: number | null;
  sharedBy: { id: string; name: string } | null;
  feedbackCounts: RadarFeedbackCount;
  myFeedbacks: RadarFeedbackType[];
  commentCount: number;
  // Phase 2A deep-dive: original source + enrichment metadata. Optional
  // — pre-Phase-0 rows will be null across the board.
  originalKind: string | null;
  originalMarkdown: string | null;
  originalMeta: unknown;
  githubItemMeta: RadarGithubItemMeta | null;
  repoSummary: string | null;
  highlights: {
    summary: string;
    highlights: string[];
    keyQuote: string | null;
  } | null;
  arxivAnalysis: RadarArxivAnalysis | null;
  // Phase 2B deep-dive: arxiv paper parsed structure.
  tldr: string | null;
  sections: Array<{ title: string; level: number; startOffset: number; page?: number }> | null;
  figures: Array<{ page: number; caption?: string; dataUrl?: string }> | null;
  authors: string[];
};

/** 列表默认反馈计数（避免每个候选都 groupBy 一次）。 */
export function emptyFeedbackCounts(): RadarFeedbackCount {
  return { useful: 0, inaccurate: 0, used: 0, favorite: 0, suggest_research: 0 };
}

/** 从 raw prisma 行做类型对齐；返回可序列化对象。 */
export function shapeCandidate(input: {
  summary: {
    id: string;
    title: string;
    body: string;
    url: string;
    tags: string[];
    status: string;
    summaryDate: Date;
    publishedAt: Date | null;
    createdAt: Date;
    interpretation: string | null;
    scoreReason: string | null;
    scoreVersion: string | null;
    relevanceScore: number | null;
    timelinessScore: number | null;
    sourceQualityScore: number | null;
    distilledScore: unknown;
    selectionReason: string | null;
    sortOrder: number | null;
    syncRunId: string | null;
    source?: string;
    originalKind?: string | null;
    originalMarkdown?: string | null;
    originalMeta?: unknown;
    repoSummary?: string | null;
    highlights?: unknown;
    arxivAnalysis?: unknown;
    tldr?: string | null;
    sections?: unknown;
    figures?: unknown;
    authors?: string[];
    sharedBy?: { id: string; name: string } | null;
    syncRun?: {
      id: string;
      completedAt: Date | null;
      source: { sourceType: string; name: string } | null;
    } | null;
    _count?: { comments: number };
  };
  feedbackCounts?: RadarFeedbackCount;
  myFeedbacks?: RadarFeedbackType[];
  includeBody?: boolean;
}): RadarCandidateShape {
  const s = input.summary;
  const counts = input.feedbackCounts ?? emptyFeedbackCounts();
  const mine = input.myFeedbacks ?? [];
  const distilledScore = parseDistilledScore(s.distilledScore);
  const highlights = parseHighlights(s.highlights);
  const arxivAnalysis = parseArxivAnalysis(s.arxivAnalysis);
  const githubItemMeta = parseGithubItemMeta(s.originalMeta);
  return {
    id: s.id,
    title: s.title,
    excerpt: excerptOf(s.body, 280),
    body: input.includeBody === false ? null : s.body,
    url: s.url,
    sourceType: s.syncRun?.source?.sourceType ?? (s.source === 'user' ? 'web_share' : null),
    syncRunId: s.syncRunId,
    syncDate: s.syncRun?.completedAt
      ? s.syncRun.completedAt.toISOString()
      : null,
    tags: s.tags,
    status: s.status,
    publishedAt: s.publishedAt ? s.publishedAt.toISOString() : null,
    crawledAt: s.createdAt.toISOString(),
    interpretation: s.interpretation,
    scoreReason: s.scoreReason,
    scoreVersion: s.scoreVersion,
    relevanceScore: s.relevanceScore,
    timelinessScore: s.timelinessScore,
    sourceQualityScore: s.sourceQualityScore,
    distilledScore,
    summaryDate: s.summaryDate.toISOString().slice(0, 10),
    selectionReason: s.selectionReason,
    sortOrder: s.sortOrder,
    sharedBy: s.sharedBy ?? null,
    feedbackCounts: counts,
    myFeedbacks: mine,
    commentCount: s._count?.comments ?? 0,
    originalKind: s.originalKind ?? null,
    originalMarkdown: s.originalMarkdown ?? null,
    originalMeta: s.originalMeta ?? null,
    githubItemMeta,
    repoSummary: s.repoSummary ?? null,
    highlights,
    arxivAnalysis,
    tldr: s.tldr ?? null,
    sections: Array.isArray(s.sections)
      ? (s.sections as Array<{ title: string; level: number; startOffset: number; page?: number }>)
      : null,
    figures: Array.isArray(s.figures)
      ? (s.figures as Array<{ page: number; caption?: string; dataUrl?: string }>)
      : null,
    authors: Array.isArray(s.authors) ? s.authors : [],
  };
}

export type RadarArxivAnalysis = {
  tldr: string;
  motivation: string;
  method: string;
  result: string;
  conclusion: string;
};

export type RadarGithubItemMeta = {
  kind: 'issue' | 'pr' | 'release';
  owner: string;
  repo: string;
  numberOrTag: string;
  state: string | null;
  labels: string[];
  comments: number;
  author: string | null;
  createdAt: string | null;
  updatedAt: string | null;
  publishedAt: string | null;
  tagName: string | null;
  draft: boolean;
  locked: boolean;
  assetCount: number;
  bodyPreview: string | null;
  commentPreviews: Array<{ author: string | null; body: string; createdAt: string | null }>;
};

export function parseGithubItemMeta(value: unknown): RadarGithubItemMeta | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  if (raw.provider !== 'github_item') return null;
  if (raw.kind !== 'issue' && raw.kind !== 'pr' && raw.kind !== 'release') return null;

  const owner = typeof raw.owner === 'string' ? raw.owner.trim() : '';
  const repo = typeof raw.repo === 'string' ? raw.repo.trim() : '';
  const numberOrTag = typeof raw.numberOrTag === 'string' ? raw.numberOrTag.trim() : '';
  if (!owner || !repo || !numberOrTag) return null;
  const optionalText = (value: unknown) =>
    typeof value === 'string' && value.trim() ? value.trim() : null;
  const commentPreviews = Array.isArray(raw.commentPreviews)
    ? raw.commentPreviews.flatMap((value) => {
      if (!value || typeof value !== 'object' || Array.isArray(value)) return [];
      const comment = value as Record<string, unknown>;
      const body = optionalText(comment.body);
      if (!body) return [];
      return [{
        author: optionalText(comment.author),
        body,
        createdAt: optionalText(comment.createdAt),
      }];
    }).slice(0, 3)
    : [];

  return {
    kind: raw.kind,
    owner,
    repo,
    numberOrTag,
    state: optionalText(raw.state),
    labels: Array.isArray(raw.labels)
      ? raw.labels.filter((item): item is string => typeof item === 'string' && Boolean(item.trim())).slice(0, 20)
      : [],
    comments: typeof raw.comments === 'number' && raw.comments >= 0 ? raw.comments : 0,
    author: optionalText(raw.author),
    createdAt: optionalText(raw.createdAt),
    updatedAt: optionalText(raw.updatedAt),
    publishedAt: optionalText(raw.published_at ?? raw.publishedAt),
    tagName: optionalText(raw.tag_name ?? raw.tagName),
    draft: raw.draft === true,
    locked: raw.locked === true,
    assetCount: typeof raw.assetCount === 'number' && raw.assetCount >= 0 ? raw.assetCount : 0,
    bodyPreview: optionalText(raw.bodyPreview),
    commentPreviews,
  };
}

export function parseArxivAnalysis(value: unknown): RadarArxivAnalysis | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  const text = (key: keyof RadarArxivAnalysis) =>
    typeof raw[key] === 'string' ? raw[key].trim() : '';
  const analysis = {
    tldr: text('tldr'),
    motivation: text('motivation'),
    method: text('method'),
    result: text('result'),
    conclusion: text('conclusion'),
  };
  return Object.values(analysis).some(Boolean) ? analysis : null;
}

/** Accept current camelCase scores and the snake_case payload written by early v2 syncs. */
export function parseDistilledScore(value: unknown): DistilledScore | null {
  const current = DistilledScoreSchema.safeParse(value);
  if (current.success) return current.data;
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;

  const raw = value as Record<string, unknown>;
  const dimensions = raw.dimensions;
  if (!dimensions || typeof dimensions !== 'object' || Array.isArray(dimensions)) return null;
  const dims = dimensions as Record<string, unknown>;
  const normalized = {
    total: raw.total,
    effectiveTotal: raw.effectiveTotal ?? raw.effective_total,
    qualityScore: raw.qualityScore ?? raw.quality_score,
    teamValueScore: raw.teamValueScore ?? raw.team_value_score,
    rankingScore: raw.rankingScore ?? raw.ranking_score,
    sourceBonus: raw.sourceBonus ?? raw.source_bonus,
    tier: raw.tier,
    mustRead: raw.mustRead ?? raw.must_read,
    dimensions: {
      informationGain: dims.informationGain ?? dims.info_increment,
      analysisDepth: dims.analysisDepth ?? dims.analysis_depth,
      actionability: dims.actionability,
      factualReliability: dims.factualReliability ?? dims.fact_credibility,
      currentApplicability: dims.currentApplicability ?? dims.timeliness,
      expressionQuality: dims.expressionQuality ?? dims.expression_quality,
      audienceFit: dims.audienceFit ?? dims.audience_fit,
    },
    weakPoint: raw.weakPoint ?? raw.weak_point,
    veto: raw.veto,
    riskFlags: raw.riskFlags ?? raw.risk_flags ?? [],
    profile: raw.profile,
    profileFallback: raw.profileFallback ?? raw.profile_fallback,
    isDefault: raw.isDefault ?? raw.is_default,
    version: raw.version,
    directRelevance: raw.directRelevance ?? raw.direct_relevance,
    relevanceEvidence: raw.relevanceEvidence ?? raw.relevance_evidence,
  };
  const legacy = DistilledScoreSchema.safeParse(normalized);
  return legacy.success ? legacy.data : null;
}

export function parseHighlights(value: unknown): RadarCandidateShape['highlights'] {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  const points = Array.isArray(raw.highlights)
    ? raw.highlights.filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
    : [];
  const summary = typeof raw.summary === 'string' ? raw.summary.trim() : '';
  const keyQuoteRaw = raw.key_quote ?? raw.keyQuote;
  const keyQuote = typeof keyQuoteRaw === 'string' && keyQuoteRaw.trim()
    ? keyQuoteRaw.trim()
    : null;
  if (!summary && points.length === 0 && !keyQuote) return null;
  return { summary, highlights: points, keyQuote };
}

/** 取前 N 个字符；保留换行前的整段语义边界（句号/问号/感叹号/换行）。 */
export function excerptOf(body: string, max: number): string {
  if (body.length <= max) return body;
  const contentLimit = Math.max(0, max - 1);
  const sliced = body.slice(0, contentLimit);
  const boundary = Math.max(
    sliced.lastIndexOf('.'),
    sliced.lastIndexOf('!'),
    sliced.lastIndexOf('?'),
    sliced.lastIndexOf('\n'),
  );
  if (boundary >= contentLimit / 3) {
    return sliced.slice(0, boundary + 1);
  }
  return sliced + '…';
}

/** 把 YYYY-MM-DD 字符串（UTC 当日 00:00:00）解析成 Date 对象。 */
export function parseUtcDate(yyyyMmDd: string): Date {
  const [y, m, d] = yyyyMmDd.split('-').map((s) => Number(s));
  return new Date(Date.UTC(y, m - 1, d));
}

/** 把 Date 转 YYYY-MM-DD（UTC）。 */
export function isoDateOf(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/**
 * 取一组 summaryId 的反馈：counts（按 type 分组）+ myFeedbacks（当前用户）。
 * 用单次 groupBy 拿 counts；再单次 where 拿 myFeedbacks。
 *
 * 类型策略：直接接受 PrismaClient（不展开 groupBy 复杂泛型），但保持调用方
 * 类型安全。
 */
export async function aggregateFeedbacks(
  prisma: any,
  summaryIds: string[],
  userId: string,
): Promise<Map<string, { counts: RadarFeedbackCount; mine: RadarFeedbackType[] }>> {
  const result = new Map<string, { counts: RadarFeedbackCount; mine: RadarFeedbackType[] }>();
  for (const id of summaryIds) {
    result.set(id, { counts: emptyFeedbackCounts(), mine: [] });
  }
  if (summaryIds.length === 0) return result;

  const grouped: Array<{ summaryId: string; feedbackType: string; _count: { feedbackType: number } }> =
    await prisma.radarFeedback.groupBy({
      by: ['summaryId', 'feedbackType'],
      where: { summaryId: { in: summaryIds } },
      _count: { feedbackType: true },
    });
  for (const row of grouped) {
    const entry = result.get(row.summaryId);
    if (!entry) continue;
    const ft = row.feedbackType as keyof RadarFeedbackCount;
    if (ft in entry.counts) {
      entry.counts[ft] = row._count.feedbackType;
    }
  }

  const mine: Array<{ summaryId: string; feedbackType: string }> =
    await prisma.radarFeedback.findMany({
      where: { summaryId: { in: summaryIds }, userId },
      select: { summaryId: true, feedbackType: true },
    });
  for (const row of mine) {
    const entry = result.get(row.summaryId);
    if (!entry) continue;
    entry.mine.push(row.feedbackType as RadarFeedbackType);
  }

  return result;
}

/** 简单标签归一化（lowercase + trim + 去空）；不修改输入数组。 */
export function normalizeTags(tags: readonly string[]): string[] {
  const out: string[] = [];
  for (const t of tags) {
    const trimmed = t.trim().toLowerCase();
    if (trimmed.length > 0 && !out.includes(trimmed)) out.push(trimmed);
  }
  return out;
}

/**
 * 过滤 query 是否匹配候选的 title / interpretation / tags。
 * 简单大小写不敏感 substring；不在 DB 做全文检索（W5 不开 search_docs 路径）。
 */
export function matchesQuery(input: {
  query: string | undefined;
  title: string;
  interpretation: string | null;
  tags: string[];
}): boolean {
  if (!input.query || input.query.length === 0) return true;
  const q = input.query.toLowerCase();
  if (input.title.toLowerCase().includes(q)) return true;
  if (input.interpretation && input.interpretation.toLowerCase().includes(q)) return true;
  return input.tags.some((t) => t.toLowerCase().includes(q));
}
