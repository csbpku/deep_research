/**
 * Older learning paths were bounded by a pass that cut sections mid-paragraph
 * and left a visible "this section was cut at the word limit" note. They also
 * materialized citations as full Markdown links instead of compact [S#] tags.
 * The reader should see the finished artifact, not the machinery that produced
 * it, so clean both on the way to the page.
 */
const BUDGET_NOTE = /\n*（这一节已压缩到字数上限[^）]*）\n*/g;
const FULL_CITATION = /\[S(\d+)\]\((https?:\/\/[^)\s]+)\)/g;
const BIBLIOGRAPHY = /^##\s*(参考文献|参考资料|References)\s*$/m;

export function cleanLearningArtifact(body: string): string {
  const cleaned = body.replace(BUDGET_NOTE, '\n\n').replace(FULL_CITATION, '[S$1]');
  const bibliography = BIBLIOGRAPHY.exec(cleaned);
  // Older artifacts appended a bibliography after 自检; the contract is that
  // every claim is already cited inline, so the trailing list is machinery.
  const withoutBibliography =
    bibliography === null ? cleaned : cleaned.slice(0, bibliography.index);
  return withoutBibliography.trim();
}
