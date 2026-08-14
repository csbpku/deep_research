'use client';

export interface RadarGuide {
  summary?: string;
  conclusions?: Array<{ claim?: string; evidence?: string }>;
  limitations?: string[];
  openQuestions?: string[];
  highlights?: Array<{ quote?: string; rationale?: string }>;
}

interface RadarAiReadingTabProps {
  guide: RadarGuide;
  /** 点击高亮/结论证据时回链到原文段落（由父组件传入滚动逻辑） */
  onHighlightClick?: (quote: string) => void;
}

function section(title: string) {
  return (
    <h3 className="mb-2 mt-5 font-sans text-[11px] font-semibold uppercase tracking-[0.08em] text-[var(--ink-muted)]">
      {title}
    </h3>
  );
}

/**
 * AI导读 结构化内容渲染。
 *
 * 数据来自 `/api/radar/[id]/transform` 的 `guide` 字段（M5 结构化 JSON）。
 * 分区渲染：摘要 / 结论 / 限制 / 待验证 / 高亮回链。
 */
export function RadarAiReadingTab({ guide, onHighlightClick }: RadarAiReadingTabProps) {
  return (
    <div>
      {guide.summary ? (
        <p className="mb-4 font-serif text-[15px] leading-7 text-[var(--ink-text)]">{guide.summary}</p>
      ) : null}

      {guide.conclusions && guide.conclusions.length > 0 ? (
        <>
          {section('核心结论')}
          <ul className="mb-4 space-y-2 pl-5">
            {guide.conclusions.map((c, i) => (
              <li key={i} className="font-serif text-sm leading-6 text-[var(--ink-text)]">
                {c.claim}
                {c.evidence ? (
                  <button
                    type="button"
                    onClick={() => onHighlightClick?.(c.evidence!)}
                    className="mt-1 block border-l-2 border-[var(--ink-accent)] pl-2 text-[13px] text-[var(--ink-muted)] hover:text-[var(--ink-accent)]"
                  >
                    ↗ {c.evidence}
                  </button>
                ) : null}
              </li>
            ))}
          </ul>
        </>
      ) : null}

      {guide.limitations && guide.limitations.length > 0 ? (
        <>
          {section('风险与限制')}
          <ul className="mb-4 space-y-1.5 pl-5 font-serif text-sm leading-6 text-[var(--ink-muted)]">
            {guide.limitations.map((l, i) => <li key={i}>{l}</li>)}
          </ul>
        </>
      ) : null}

      {guide.openQuestions && guide.openQuestions.length > 0 ? (
        <>
          {section('待验证问题')}
          <ul className="mb-4 space-y-1.5 pl-5 font-serif text-sm leading-6 text-[var(--ink-muted)]">
            {guide.openQuestions.map((q, i) => <li key={i}>{q}</li>)}
          </ul>
        </>
      ) : null}

      {guide.highlights && guide.highlights.length > 0 ? (
        <>
          {section('原文中的这一段 ↗')}
          <div className="space-y-2">
            {guide.highlights.map((h, i) => (
              <button
                key={i}
                type="button"
                onClick={() => onHighlightClick?.(h.quote ?? '')}
                className="block w-full border-l-2 border-[var(--ink-accent)] bg-white px-3 py-2 text-left font-serif text-[13px] leading-6 text-[var(--ink-muted)] hover:bg-[var(--ink-paper)]"
              >
                <em className="not-italic font-semibold text-[var(--ink-accent)]">{h.quote}</em>
                {h.rationale ? <span className="mt-0.5 block text-xs text-[var(--ink-faint)]">{h.rationale}</span> : null}
              </button>
            ))}
          </div>
        </>
      ) : null}
    </div>
  );
}
