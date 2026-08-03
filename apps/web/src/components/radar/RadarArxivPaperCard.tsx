// Phase 2C — Radar deep-dive: arxiv paper structured view.
//
// Layout inspired by dw-dengwei/daily-arXiv-ai-enhanced's Structure
// pydantic schema (tldr / motivation / method / result / conclusion)
// combined with IMRaD academic writing conventions.
//
// ⚠️ e2e 契约：data-testid="arxiv-paper-card"

import { FileText, Lightbulb, Microscope, Sparkles, Target, TrendingUp } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';

interface ArxivAnalysis {
  tldr: string;
  motivation: string;
  method: string;
  result: string;
  conclusion: string;
}

interface Props {
  meta: { arxivId?: string; keyContributions?: string[]; sectionCount?: number };
  authors: string[];
  tldr: string | null;
  analysis: ArxivAnalysis | null;
}

function formatAuthors(authors: string[]): string {
  if (authors.length === 0) return '';
  if (authors.length === 1) return authors[0]!;
  if (authors.length <= 3) return authors.join(', ');
  return `${authors.slice(0, 3).join(', ')} 等 ${authors.length} 人`;
}

interface AnalysisBlock {
  icon: LucideIcon;
  label: string;
  text: string;
}

function buildAnalysisBlocks(analysis: ArxivAnalysis | null): AnalysisBlock[] {
  if (!analysis) return [];
  return [
    { icon: Target, label: '研究动机', text: analysis.motivation },
    { icon: Microscope, label: '研究方法', text: analysis.method },
    { icon: TrendingUp, label: '实验结果', text: analysis.result },
    { icon: Lightbulb, label: '最终结论', text: analysis.conclusion },
  ].filter((block) => block.text);
}

export function RadarArxivPaperCard({ meta, authors, tldr, analysis }: Props) {
  const blocks = buildAnalysisBlocks(analysis);

  return (
    <section data-testid="arxiv-paper-card" className="my-5 border-y border-border py-4">
      <div className="mb-3 flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <h2 className="flex items-center gap-1.5 text-sm font-semibold">
          <FileText className="size-4 text-muted-foreground" aria-hidden />
          论文解读
        </h2>
        {formatAuthors(authors) ? <span className="text-xs text-muted-foreground">{formatAuthors(authors)}</span> : null}
        {meta.arxivId ? <span className="font-mono text-[11px] text-muted-foreground">arXiv:{meta.arxivId}</span> : null}
      </div>

      {/* TL;DR */}
      {(tldr || (analysis && analysis.tldr)) && (
        <div className="mb-3 border-l-2 border-primary bg-muted/40 px-3 py-2.5">
          <div className="mb-1 flex items-center gap-1 text-[11px] font-semibold text-primary">
            <Sparkles className="size-3" />
            TL;DR
          </div>
          <p className="text-sm leading-relaxed">{analysis?.tldr || tldr}</p>
        </div>
      )}

      {/* 4 字段 IMRaD analysis —— 完整渲染，不截断。 */}
      {blocks.length > 0 && (
        <div className="divide-y divide-border border-t border-border">
          {blocks.map((block) => {
            const Icon = block.icon;
            return (
              <div key={block.label} className="grid gap-1 py-3 sm:grid-cols-[6rem_1fr] sm:gap-3">
                <div className="flex items-center gap-1 text-xs font-medium text-muted-foreground">
                  <Icon className="size-3" />
                  {block.label}
                </div>
                <p className="text-sm leading-6">{block.text}</p>
              </div>
            );
          })}
        </div>
      )}

      {/* Empty-state fallback —— LLM 还没产出解读。 */}
      {blocks.length === 0 && !tldr && (
        <div className="border-l-2 border-border pl-3 text-sm text-muted-foreground">
          论文解读尚未生成
        </div>
      )}
    </section>
  );
}
