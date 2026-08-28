'use client';

import { useEffect, useId, useState } from 'react';

let mermaidPromise: Promise<typeof import('mermaid')> | null = null;

function loadMermaid() {
  mermaidPromise ??= import('mermaid');
  return mermaidPromise;
}

export function isMermaidSource(value: string): boolean {
  return /^(?:flowchart|graph|sequenceDiagram|classDiagram|stateDiagram(?:-v2)?|erDiagram|journey|gantt|pie|mindmap|timeline|gitGraph|quadrantChart|xychart-beta|block-beta|architecture|C4Context|sankey-beta|packet-beta|kanban)\b/iu.test(
    value.trim(),
  );
}

function normalizeMermaidSource(value: string): string {
  return value
    // HTML-to-Markdown extraction can escape Mermaid's label breaks.
    .replace(/\\<br\s*\/?>/giu, '<br/>')
    // The same extraction sometimes inserts a space inside identifiers such
    // as `CC_ SS` or `JSON_ OUT`; Mermaid treats those as invalid node IDs.
    .replace(/\b([A-Za-z][A-Za-z0-9]*_)\s+([A-Za-z][A-Za-z0-9]*)\b/gu, '$1$2')
    .trim();
}

function removeMermaidTempNodes(id: string) {
  for (const tempId of [`d${id}`, `i${id}`]) {
    document.getElementById(tempId)?.remove();
  }
}

export default function MermaidDiagram({ chart }: { chart: string }) {
  const rawId = useId();
  const id = `mermaid-${rawId.replace(/[^a-zA-Z0-9_-]/gu, '')}`;
  const [svg, setSvg] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setSvg(null);
    setError(null);

    void loadMermaid()
      .then(async ({ default: mermaid }) => {
        mermaid.initialize({
          startOnLoad: false,
          securityLevel: 'strict',
          theme: 'base',
          fontFamily: 'ui-sans-serif, system-ui, sans-serif',
          themeVariables: {
            primaryColor: '#f5efe6',
            primaryTextColor: '#2f302b',
            primaryBorderColor: '#b8a991',
            lineColor: '#827663',
            secondaryColor: '#edf1ec',
            tertiaryColor: '#f7f3ed',
          },
        });
        const result = await mermaid.render(id, normalizeMermaidSource(chart));
        if (cancelled) return;
        setSvg(result.svg);
      })
      .catch((renderError: unknown) => {
        if (cancelled) return;
        setError(renderError instanceof Error ? renderError.message : '图表语法无法渲染');
      })
      .finally(() => {
        if (!cancelled) removeMermaidTempNodes(id);
      });

    return () => {
      cancelled = true;
      removeMermaidTempNodes(id);
    };
  }, [chart, id]);

  if (error) {
    return (
      <div className="my-5 overflow-hidden rounded-xl border border-amber-300/70 bg-amber-50/60">
        <div className="border-b border-amber-300/60 px-4 py-2 text-xs font-medium text-amber-900">
          图表渲染失败，已保留原始 Mermaid 内容
        </div>
        <pre className="overflow-auto whitespace-pre-wrap break-words px-4 py-3 text-xs leading-6 text-amber-950">
          {chart}
        </pre>
      </div>
    );
  }

  return (
    <figure
      className="my-6 overflow-x-auto rounded-xl border border-[var(--ink-rule)] bg-[var(--ink-page)] px-4 py-5"
      aria-label="Mermaid 图表"
    >
      {svg ? (
        <div className="flex min-w-fit justify-center [&>svg]:h-auto [&>svg]:max-w-full" dangerouslySetInnerHTML={{ __html: svg }} />
      ) : (
        <div className="h-24 animate-pulse rounded-lg bg-black/[0.04] dark:bg-white/[0.06]" aria-label="正在生成图表" />
      )}
    </figure>
  );
}
