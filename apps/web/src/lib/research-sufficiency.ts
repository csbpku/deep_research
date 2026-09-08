import type { ResearchBrief } from '@deep-research/shared/schemas';

/**
 * Research execution and fact review answer different questions.
 *
 * This module only detects an explicit, observable coverage gap in the
 * confirmed research contract. It deliberately does not infer that a report
 * is sufficient from a source count, and it never turns an unknown situation
 * into a failure. That keeps a single authoritative page from being treated
 * as insufficient when it is actually enough for a narrow question, while
 * still catching a comparison where one named option has no captured source.
 */

export type ResearchSufficiencyStatus = 'sufficient' | 'insufficient' | 'not_assessed';

export interface ResearchSufficiencyItem {
  id: string;
  label: string;
  kind: 'comparison_option' | 'official_product' | 'source_requirement';
  covered: boolean;
  evidenceCount: number;
}

export interface ResearchSufficiency {
  status: ResearchSufficiencyStatus;
  basis: 'explicit_comparison' | 'official_coverage' | 'captured_source' | 'none';
  capturedSourceCount: number;
  coveredCount: number;
  requiredCount: number;
  items: ResearchSufficiencyItem[];
  missing: string[];
}

export interface ResearchSufficiencySource {
  canonicalKey?: string | null;
  title?: string | null;
  description?: string | null;
  snippet?: string | null;
}

export interface ResearchSufficiencyInput {
  brief?: Pick<ResearchBrief, 'objective' | 'comparisonOptions'> | null;
  sources: ResearchSufficiencySource[];
  sourceCoverage?: Record<string, {
    label?: string;
    captured?: number;
    requiredCaptured?: number;
    status?: string;
  }> | null;
  /** Used only to explain a zero-source locked-scope run. */
  sourcePolicy?: string | null;
}

function normalize(value: string): string {
  return value
    .toLocaleLowerCase()
    .replace(/[\u200b\uFEFF]/gu, '')
    .replace(/[\s\p{P}\p{S}]+/gu, '')
    .trim();
}

function asciiTokens(value: string): string[] {
  return value
    .toLocaleLowerCase()
    .match(/[a-z][a-z0-9+#._-]{1,}/gu)
    ?.filter((token) => token.length >= 3) ?? [];
}

function sourceSearchText(source: ResearchSufficiencySource): string {
  return normalize([
    source.canonicalKey,
    source.title,
    source.description,
    source.snippet,
  ].filter((value): value is string => Boolean(value?.trim())).join(' '));
}

function sourceMatchesOption(option: string, source: ResearchSufficiencySource): boolean {
  const sourceText = sourceSearchText(source);
  const normalizedOption = normalize(option);
  if (!normalizedOption) return false;
  if (sourceText.includes(normalizedOption)) return true;

  // Product names are commonly written with punctuation or a suffix in the
  // source title. Requiring every meaningful ASCII token is safer than a
  // loose substring match for labels such as "AI" or "Web".
  const tokens = asciiTokens(option);
  return tokens.length > 0 && tokens.every((token) => sourceText.includes(normalize(token)));
}

function sourceCountForOption(option: string, sources: ResearchSufficiencySource[]): number {
  return sources.filter((source) => sourceMatchesOption(option, source)).length;
}

export function evaluateResearchSufficiency(input: ResearchSufficiencyInput): ResearchSufficiency {
  const capturedSources = input.sources.filter((source) => Boolean(
    (source.description ?? source.snippet)?.trim(),
  ));
  const items: ResearchSufficiencyItem[] = [];

  const options = (input.brief?.comparisonOptions ?? [])
    .map((option) => option.trim())
    .filter(Boolean);
  for (const option of Array.from(new Set(options))) {
    const evidenceCount = sourceCountForOption(option, capturedSources);
    items.push({
      id: `comparison:${option}`,
      label: option,
      kind: 'comparison_option',
      covered: evidenceCount > 0,
      evidenceCount,
    });
  }

  for (const [key, coverage] of Object.entries(input.sourceCoverage ?? {})) {
    const captured = typeof coverage.captured === 'number' ? Math.max(0, coverage.captured) : 0;
    const required = typeof coverage.requiredCaptured === 'number'
      ? Math.max(1, coverage.requiredCaptured)
      : 1;
    const covered = coverage.status === 'covered' || captured >= required;
    items.push({
      id: `official:${key}`,
      label: coverage.label?.trim() || key,
      kind: 'official_product',
      covered,
      evidenceCount: captured,
    });
  }

  const dedupedItems = Array.from(new Map(items.map((item) => [item.id, item])).values());
  const missing = dedupedItems.filter((item) => !item.covered).map((item) => item.label);
  const requiredCount = dedupedItems.length;
  const coveredCount = dedupedItems.filter((item) => item.covered).length;

  if (missing.length > 0) {
    return {
      status: 'insufficient',
      basis: dedupedItems.some((item) => item.kind === 'comparison_option')
        ? 'explicit_comparison'
        : 'official_coverage',
      capturedSourceCount: capturedSources.length,
      coveredCount,
      requiredCount,
      items: dedupedItems,
      missing,
    };
  }

  if (requiredCount > 0) {
    return {
      status: 'sufficient',
      basis: dedupedItems.some((item) => item.kind === 'comparison_option')
        ? 'explicit_comparison'
        : 'official_coverage',
      capturedSourceCount: capturedSources.length,
      coveredCount,
      requiredCount,
      items: dedupedItems,
      missing: [],
    };
  }

  if (capturedSources.length > 0) {
    // A captured source proves that the run has evidence to inspect; it does
    // not prove that the evidence covers the whole question. Without an
    // explicit comparison/coverage contract, stay honest and leave
    // completeness unassessed instead of upgrading one source to "sufficient".
    return {
      status: 'not_assessed',
      basis: 'captured_source',
      capturedSourceCount: capturedSources.length,
      coveredCount: 0,
      requiredCount: 0,
      items: [],
      missing: [],
    };
  }

  return {
    status: input.sourcePolicy === 'only_user_sources' ? 'insufficient' : 'not_assessed',
    basis: input.sourcePolicy === 'only_user_sources' ? 'captured_source' : 'none',
    capturedSourceCount: 0,
    coveredCount: 0,
    requiredCount: 0,
    items: [],
    missing: input.sourcePolicy === 'only_user_sources' ? ['没有保存可核对的指定资料'] : [],
  };
}
