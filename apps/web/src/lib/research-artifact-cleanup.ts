/**
 * Older learning paths were bounded by a pass that cut sections mid-paragraph
 * and left a visible "this section was cut at the word limit" note. They also
 * materialized citations as full Markdown links instead of compact [S#] tags.
 * The reader should see the finished artifact, not the machinery that produced
 * it, so clean both on the way to the page.
 */
const BUDGET_NOTE = /\n*（这一节已压缩到字数上限[^）]*）\n*/g;
const FULL_CITATION = /\[S(\d+)\]\((https?:\/\/[^)\s]+)\)/g;

export function cleanLearningArtifact(body: string): string {
  return body.replace(BUDGET_NOTE, '\n\n').replace(FULL_CITATION, '[S$1]').trim();
}
