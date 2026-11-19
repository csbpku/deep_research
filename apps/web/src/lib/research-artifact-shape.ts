/**
 * Some AI artifacts carry their own document contract (decision memo, learning
 * path, comparison matrix, or an intent-specific report). For those, the
 * generic 研究摘要 block repeats sections that already exist in the body and
 * can even contradict them, so the detail page should not render it twice.
 */
// Each intent opens with its own first section. `investigate` has no single
// stable heading beyond "现象与范围"; `explore` likewise only guarantees the
// overview. Keep the list narrow so a normal research report that merely
// quotes one of these words is not mistaken for an intent artifact.
const INTENT_BODY_HEADINGS = [
  '现象与范围',
  '一句话回答',
  '一句话概览',
  '对比结论',
  '建议',
];

// Legacy or hand-written artifacts may start with a title line and put the
// contract on line 2-4, e.g. "# 机制分析\n\n## 现象与范围". Look only at the
// opening block, never the whole document.
const OPENING_HEADING_WINDOW = 4;

export interface ArtifactShapeInput {
  type: string;
  reportType?: string | null;
  body: string;
}

function opensWithIntentHeading(body: string): boolean {
  const opening = body.trimStart().split(/\r?\n/u).slice(0, OPENING_HEADING_WINDOW);
  return opening.some(line => INTENT_BODY_HEADINGS.some(heading => new RegExp(`^##\\s+${heading}$`, 'u').test(line.trim())));
}

export function hasOwnArtifactContract({ type, reportType, body }: ArtifactShapeInput): boolean {
  if (type !== 'research') return false;
  if (reportType === 'learning_path' || reportType === 'comparison_matrix') return true;
  // `investigate` / `explore` reports are rendered from the body alone: their
  // first ``##`` heading is the contract. A stored summary would repeat and
  // may contradict it, so treat the opening heading as authoritative.
  if (opensWithIntentHeading(body)) return true;
  // Decision memos are identified by their title line rather than a heading.
  return body.trimStart().startsWith('# 决策备忘');
}

export function shouldRenderResearchSummary(
  input: ArtifactShapeInput,
  summary: { background?: string | null; conclusion?: string | null; risks?: string | null },
): boolean {
  if (!summary.background && !summary.conclusion && !summary.risks) return false;
  return !hasOwnArtifactContract(input);
}
