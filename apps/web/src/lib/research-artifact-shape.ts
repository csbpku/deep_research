/**
 * Some AI artifacts carry their own document contract (decision memo, learning
 * path, comparison matrix, or an intent-specific report). For those, the
 * generic 研究摘要 block repeats sections that already exist in the body and
 * can even contradict them, so the detail page should not render it twice.
 */
const INTENT_BODY_HEADINGS = [
  '现象与范围',
  '一句话回答',
  '一句话概览',
  '对比结论',
  '建议',
];

export interface ArtifactShapeInput {
  type: string;
  reportType?: string | null;
  body: string;
}

export function hasOwnArtifactContract({ type, reportType, body }: ArtifactShapeInput): boolean {
  if (type !== 'research') return false;
  if (reportType === 'learning_path' || reportType === 'comparison_matrix') return true;
  const start = body.trimStart();
  if (start.startsWith('# 决策备忘')) return true;
  // Only the opening contract counts: a normal report may quote "一句话回答"
  // or "建议" deeper in the body without owning the artifact contract.
  const opening = start.split(/\r?\n/u)[0]?.trim() ?? '';
  return INTENT_BODY_HEADINGS.some(heading => new RegExp(`^##\\s+${heading}$`, 'u').test(opening));
}

export function shouldRenderResearchSummary(
  input: ArtifactShapeInput,
  summary: { background?: string | null; conclusion?: string | null; risks?: string | null },
): boolean {
  if (!summary.background && !summary.conclusion && !summary.risks) return false;
  return !hasOwnArtifactContract(input);
}
