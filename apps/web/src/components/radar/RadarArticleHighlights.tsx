import { Quote } from 'lucide-react';

interface Props {
  summary: string;
  highlights: string[];
  keyQuote: string | null;
}

export function RadarArticleHighlights({ summary, highlights, keyQuote }: Props) {
  return (
    <section className="my-5 border-y border-border py-4" aria-labelledby="article-highlights-title">
      <h2 id="article-highlights-title" className="mb-3 text-sm font-semibold">摘要与亮点</h2>
      {summary ? <p className="mb-3 text-sm leading-6 text-foreground/90">{summary}</p> : null}
      {highlights.length > 0 ? (
        <ul className="space-y-2 text-sm leading-6">
          {highlights.map((item, index) => (
            <li key={`${index}-${item}`} className="grid grid-cols-[1rem_1fr] gap-2">
              <span className="font-mono text-xs tabular-nums text-primary">{index + 1}</span>
              <span>{item}</span>
            </li>
          ))}
        </ul>
      ) : null}
      {keyQuote ? (
        <blockquote className="mt-4 flex gap-2 border-l-2 border-border pl-3 text-sm italic leading-6 text-muted-foreground">
          <Quote className="mt-1 size-3.5 shrink-0" aria-hidden />
          <span>{keyQuote}</span>
        </blockquote>
      ) : null}
    </section>
  );
}
