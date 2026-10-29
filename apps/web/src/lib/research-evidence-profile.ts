/** Reader-facing evidence classification; raw engine counters remain diagnostic. */
export interface ResearchEvidenceSource {
  canonicalKey?: string | null;
  href?: string | null;
  type?: string | null;
  sourceRef?: unknown;
  snippet?: string | null;
}

export function isSyntheticResearchSource(source: ResearchEvidenceSource): boolean {
  const ref = source.sourceRef && typeof source.sourceRef === 'object' && !Array.isArray(source.sourceRef)
    ? source.sourceRef as Record<string, unknown> : {};
  const values = [source.canonicalKey, source.href, ref.value];
  return values.some((value) => typeof value === 'string' && /^(?:context|model|plan):/iu.test(value.trim()))
    || [source.type, ref.type].some((value) => typeof value === 'string' && /^(?:context|model|plan)$/iu.test(value));
}

interface EvidenceCountInput {
  reportType?: string | null;
  capturedSourcesCount?: number;
  partialSourcesCount?: number;
  researchProgress?: { sourcesCaptured?: number } | null;
  sources?: ReadonlyArray<ResearchEvidenceSource>;
}

export function capturedResearchSourceCount(input: EvidenceCountInput): number {
  if (input.reportType === 'summary_brief') {
    // Brief runtime counters can include a synthetic "context:job" source.
    // A confirmed zero from the BFF must not be raised by those raw counters.
    if (typeof input.capturedSourcesCount === 'number' && Number.isFinite(input.capturedSourcesCount)) {
      return Math.max(0, input.capturedSourcesCount);
    }
    return (input.sources ?? []).filter((source) => Boolean(source.snippet?.trim())
      && !isSyntheticResearchSource(source) && Boolean(source.href || source.sourceRef)).length;
  }
  return Math.max(input.capturedSourcesCount ?? 0, input.partialSourcesCount ?? 0, input.researchProgress?.sourcesCaptured ?? 0);
}
