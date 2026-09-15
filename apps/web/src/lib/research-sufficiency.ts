import { DEFAULT_RESEARCH_DECISION_DIMENSIONS, type ResearchBrief } from '@deep-research/shared/schemas';

/**
 * Research execution and fact review answer different questions. This module
 * answers a narrower one: did the run cover the contract the user confirmed?
 * For decision research, the required unit is an option × decision-dimension
 * cell, not a raw source count.
 */

export type ResearchSufficiencyStatus = 'sufficient' | 'insufficient' | 'not_assessed';
export type DecisionCoverageState = 'evidence' | 'not_found' | 'needs_test';

export interface ResearchSufficiencyItem {
  id: string;
  label: string;
  kind: 'comparison_option' | 'official_product' | 'source_requirement';
  covered: boolean;
  evidenceCount: number;
}

export interface ResearchCoverageCell {
  id: string;
  option: string;
  dimension: string;
  state: DecisionCoverageState;
  evidenceCount: number;
  /** Same-domain mirrors count as one independent evidence cluster. */
  independentSourceCount: number;
}

export interface ResearchCoverageMatrix {
  options: string[];
  dimensions: string[];
  cells: ResearchCoverageCell[];
  complete: boolean;
  missingCells: string[];
}

export interface StructuredRecommendationQuality {
  status: 'complete' | 'incomplete' | 'not_assessed';
  requiredFields: string[];
  presentFields: string[];
  missingFields: string[];
}

export interface ResearchSufficiency {
  status: ResearchSufficiencyStatus;
  basis: 'explicit_comparison' | 'decision_matrix' | 'official_coverage' | 'captured_source' | 'none';
  capturedSourceCount: number;
  independentSourceCount: number;
  coveredCount: number;
  requiredCount: number;
  items: ResearchSufficiencyItem[];
  missing: string[];
  matrix: ResearchCoverageMatrix | null;
  recommendation: StructuredRecommendationQuality;
}

export interface ResearchSufficiencySource {
  id?: string | null;
  canonicalKey?: string | null;
  title?: string | null;
  description?: string | null;
  snippet?: string | null;
  sourceRef?: unknown;
}

interface SufficiencyBrief {
  objective: ResearchBrief['objective'];
  comparisonOptions: string[];
  decisionDimensions?: string[];
}

export interface ResearchSufficiencyInput {
  brief?: SufficiencyBrief | null;
  sources: ResearchSufficiencySource[];
  sourceCoverage?: Record<string, {
    label?: string;
    captured?: number;
    requiredCaptured?: number;
    status?: string;
  }> | null;
  /** The final report is checked only for decision runs. */
  reportContent?: string | null;
  sourcePolicy?: string | null;
}

const RECOMMENDATION_FIELDS = [
  ['recommendation', /(?:^|\n)\s*(?:[-*]\s*)?(?:推荐方案|最终推荐|推荐选择)\s*[:：]/iu],
  ['preconditions', /(?:^|\n)\s*(?:[-*]\s*)?适用前提\s*[:：]/iu],
  ['notRecommended', /(?:^|\n)\s*(?:[-*]\s*)?(?:不推荐条件|不适用条件|不建议使用)\s*[:：]/iu],
  ['confidence', /(?:^|\n)\s*(?:[-*]\s*)?置信度\s*[:：]/iu],
  ['unconfirmedRisks', /(?:^|\n)\s*(?:[-*]\s*)?(?:未确认风险|未确认的风险|剩余风险)\s*[:：]/iu],
  ['nextValidation', /(?:^|\n)\s*(?:[-*]\s*)?(?:下一步验证动作|下一步验证|验证动作|下一步行动)\s*[:：]/iu],
] as const;

const EMPIRICAL_DIMENSION_SIGNALS = /(实测|性能|网络|测速|带宽|延迟|磁盘|资源占用|构建|部署|回滚|恢复|可靠性|成本|耗时|失败率|benchmark|speed|latency|disk|build|deploy|rollback|recovery|cost|reliability)/iu;
const DIMENSION_ALIASES: Record<string, string[]> = {
  '效果与适用范围': ['效果', '适用', '能力', '功能', 'use case', 'capability'],
  '成本与资源': ['成本', '资源', '价格', '费用', 'token', 'cost'],
  '网络/性能实测': ['网络', '性能', '测速', '带宽', '延迟', '速度', 'benchmark', 'speed', 'latency'],
  '磁盘与资源占用': ['磁盘', '存储', '空间', '内存', 'cpu', '资源占用', 'disk', 'storage'],
  '部署与构建': ['部署', '构建', '镜像', '安装', 'build', 'deploy', 'image', 'install'],
  '回滚与恢复': ['回滚', '恢复', '备份', '版本', 'rollback', 'restore', 'backup', 'recovery'],
  '可运维性': ['运维', '监控', '日志', '升级', '维护', 'operation', 'monitoring', 'maintenance'],
  '安全与风险': ['安全', '风险', '权限', '漏洞', '合规', 'security', 'risk', 'vulnerability'],
};

function normalize(value: string): string {
  return value.toLocaleLowerCase().replace(/[\u200b\uFEFF]/gu, '').replace(/[\s\p{P}\p{S}]+/gu, '').trim();
}

function asciiTokens(value: string): string[] {
  return value.toLocaleLowerCase().match(/[a-z][a-z0-9+#._-]{1,}/gu)?.filter((token) => token.length >= 3) ?? [];
}

function sourceSearchText(source: ResearchSufficiencySource): string {
  return normalize([source.canonicalKey, source.title, source.description, source.snippet]
    .filter((value): value is string => Boolean(value?.trim())).join(' '));
}

function sourceMatchesOption(option: string, source: ResearchSufficiencySource): boolean {
  const sourceText = sourceSearchText(source);
  const normalizedOption = normalize(option);
  if (!normalizedOption) return false;
  if (sourceText.includes(normalizedOption)) return true;
  const tokens = asciiTokens(option);
  return tokens.length > 0 && tokens.every((token) => sourceText.includes(normalize(token)));
}

function sourceMatchesDimension(dimension: string, source: ResearchSufficiencySource): boolean {
  const sourceText = sourceSearchText(source);
  return (DIMENSION_ALIASES[dimension] ?? [dimension]).some((alias) => {
    const normalized = normalize(alias);
    return normalized.length > 1 && sourceText.includes(normalized);
  });
}

function sourceHost(source: ResearchSufficiencySource): string | null {
  const value = source.canonicalKey?.trim();
  if (!value) return null;
  try {
    return new URL(value).hostname.toLocaleLowerCase().replace(/^www\./u, '') || null;
  } catch {
    return null;
  }
}

function uniqueCapturedSources(sources: ResearchSufficiencySource[]): ResearchSufficiencySource[] {
  const seen = new Set<string>();
  return sources.filter((source) => {
    const key = normalize(source.canonicalKey ?? source.title ?? '');
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function independentCount(sources: ResearchSufficiencySource[]): number {
  const identities = new Set<string>();
  for (const source of sources) identities.add(sourceHost(source) ?? normalize(source.canonicalKey ?? source.title ?? ''));
  return identities.size;
}

function recommendationQuality(brief: SufficiencyBrief | null | undefined, reportContent: string | null | undefined): StructuredRecommendationQuality {
  const requiredFields = RECOMMENDATION_FIELDS.map(([name]) => name);
  if (brief?.objective !== 'decide' || !reportContent?.trim()) {
    return { status: 'not_assessed', requiredFields, presentFields: [], missingFields: [] };
  }
  const presentFields = RECOMMENDATION_FIELDS.filter(([, pattern]) => pattern.test(reportContent)).map(([name]) => name);
  const missingFields = requiredFields.filter((field) => !presentFields.includes(field));
  return { status: missingFields.length === 0 ? 'complete' : 'incomplete', requiredFields, presentFields, missingFields };
}

export function evaluateResearchSufficiency(input: ResearchSufficiencyInput): ResearchSufficiency {
  const capturedSources = uniqueCapturedSources(input.sources.filter((source) => Boolean((source.description ?? source.snippet)?.trim())));
  const items: ResearchSufficiencyItem[] = [];
  const options = Array.from(new Set((input.brief?.comparisonOptions ?? []).map((option) => option.trim()).filter(Boolean)));
  const isDecision = input.brief?.objective === 'decide';
  const dimensions = isDecision
    ? Array.from(new Set((input.brief?.decisionDimensions?.length ? input.brief.decisionDimensions : DEFAULT_RESEARCH_DECISION_DIMENSIONS).map((dimension) => dimension.trim()).filter(Boolean)))
    : [];

  for (const option of options) {
    const evidenceCount = capturedSources.filter((source) => sourceMatchesOption(option, source)).length;
    items.push({ id: `comparison:${option}`, label: option, kind: 'comparison_option', covered: evidenceCount > 0, evidenceCount });
  }

  const cells: ResearchCoverageCell[] = [];
  for (const option of options) {
    for (const dimension of dimensions) {
      const matching = capturedSources.filter((source) => sourceMatchesOption(option, source) && sourceMatchesDimension(dimension, source));
      const state: DecisionCoverageState = matching.length > 0 ? 'evidence' : EMPIRICAL_DIMENSION_SIGNALS.test(dimension) ? 'needs_test' : 'not_found';
      cells.push({ id: `comparison:${option}:${dimension}`, option, dimension, state, evidenceCount: matching.length, independentSourceCount: independentCount(matching) });
    }
  }
  const missingCells = cells.filter((cell) => cell.state !== 'evidence').map((cell) => `${cell.option} × ${cell.dimension}`);
  const matrix: ResearchCoverageMatrix | null = isDecision && options.length > 0
    ? { options, dimensions, cells, complete: missingCells.length === 0, missingCells }
    : null;

  for (const [key, coverage] of Object.entries(input.sourceCoverage ?? {})) {
    const captured = typeof coverage.captured === 'number' ? Math.max(0, coverage.captured) : 0;
    const required = typeof coverage.requiredCaptured === 'number' ? Math.max(1, coverage.requiredCaptured) : 1;
    items.push({ id: `official:${key}`, label: coverage.label?.trim() || key, kind: 'official_product', covered: coverage.status === 'covered' || captured >= required, evidenceCount: captured });
  }

  const dedupedItems = Array.from(new Map(items.map((item) => [item.id, item])).values());
  const recommendation = recommendationQuality(input.brief, input.reportContent);
  const missing = dedupedItems.filter((item) => !item.covered).map((item) => item.label);
  if (matrix && missingCells.length > 0) missing.push(...missingCells);
  if (recommendation.status === 'incomplete') missing.push(`结构化推荐（缺少：${recommendation.missingFields.join('、')}）`);
  const requiredCount = matrix?.cells.length ?? dedupedItems.length;
  const coveredCount = matrix?.cells.filter((cell) => cell.state === 'evidence').length ?? dedupedItems.filter((item) => item.covered).length;
  const basis = matrix ? 'decision_matrix' : dedupedItems.some((item) => item.kind === 'comparison_option') ? 'explicit_comparison' : 'official_coverage';

  if (missing.length > 0) return { status: 'insufficient', basis, capturedSourceCount: capturedSources.length, independentSourceCount: independentCount(capturedSources), coveredCount, requiredCount, items: dedupedItems, missing, matrix, recommendation };
  if (requiredCount > 0) return { status: 'sufficient', basis, capturedSourceCount: capturedSources.length, independentSourceCount: independentCount(capturedSources), coveredCount, requiredCount, items: dedupedItems, missing: [], matrix, recommendation };
  if (capturedSources.length > 0) return { status: 'not_assessed', basis: 'captured_source', capturedSourceCount: capturedSources.length, independentSourceCount: independentCount(capturedSources), coveredCount: 0, requiredCount: 0, items: [], missing: [], matrix: null, recommendation };
  const locked = input.sourcePolicy === 'only_user_sources';
  return { status: locked ? 'insufficient' : 'not_assessed', basis: locked ? 'captured_source' : 'none', capturedSourceCount: 0, independentSourceCount: 0, coveredCount: 0, requiredCount: 0, items: [], missing: locked ? ['没有保存可核对的指定资料'] : [], matrix: null, recommendation };
}
