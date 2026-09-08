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

function readInkColor(variable: string, fallback: string): string {
  const value = getComputedStyle(document.documentElement).getPropertyValue(variable).trim();
  return value || fallback;
}

export default function MermaidDiagram({ chart }: { chart: string }) {
  const rawId = useId();
  const id = `mermaid-${rawId.replace(/[^a-zA-Z0-9_-]/gu, '')}`;
  const [svg, setSvg] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [themeVersion, setThemeVersion] = useState(0);

  useEffect(() => {
    const observer = new MutationObserver(() => setThemeVersion((version) => version + 1));
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] });
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    let cancelled = false;
    setSvg(null);
    setError(null);

    void loadMermaid()
      .then(async ({ default: mermaid }) => {
        const dark = document.documentElement.classList.contains('dark');
        const inkPage = readInkColor('--ink-page', dark ? '#1d2026' : '#ffffff');
        const inkSurface = readInkColor('--ink-surface', dark ? '#252a32' : '#eef0eb');
        const inkText = readInkColor('--ink-text', dark ? '#f1f3ef' : '#20211f');
        const inkMuted = readInkColor('--ink-muted', dark ? '#b7bdb6' : '#5e625d');
        const inkAccent = readInkColor('--ink-accent', dark ? '#8eabff' : '#315fe8');
        const inkRule = readInkColor('--ink-rule', dark ? '#343b45' : '#d9ddd5');
        mermaid.initialize({
          startOnLoad: false,
          securityLevel: 'strict',
          theme: 'base',
          fontFamily: 'ui-sans-serif, system-ui, sans-serif',
          themeVariables: {
            primaryColor: inkSurface,
            primaryTextColor: inkText,
            primaryBorderColor: inkAccent,
            lineColor: inkMuted,
            secondaryColor: inkPage,
            tertiaryColor: inkSurface,
            clusterBkg: inkPage,
            clusterBorder: inkRule,
            edgeLabelBackground: inkPage,
          },
        });
        const result = await mermaid.render(id, normalizeMermaidSource(chart));
        if (cancelled) return;
        if (/syntax error in text|parse error/iu.test(result.svg)) {
          throw new Error('图表语法无法渲染');
        }
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
  }, [chart, id, themeVersion]);

  if (error) {
    return (
      <div className="my-5 overflow-hidden rounded-md border border-warning-border/70 bg-warning-bg/60">
        <details>
          <summary className="cursor-pointer px-4 py-2 text-xs font-medium text-warning-fg">
            图表暂时无法绘制，查看原始图表文本
          </summary>
          <pre className="overflow-auto whitespace-pre-wrap break-words border-t border-warning-border/60 px-4 py-3 text-xs leading-6 text-warning-fg">
            {chart}
          </pre>
        </details>
      </div>
    );
  }

  return (
    <figure
      className="my-6 overflow-x-auto rounded-md border border-[var(--ink-rule)] bg-[var(--ink-page)] px-4 py-5"
      aria-label="Mermaid 图表"
    >
      {svg ? (
        <div className="flex min-w-fit justify-center [&>svg]:h-auto [&>svg]:max-w-full" dangerouslySetInnerHTML={{ __html: svg }} />
      ) : (
        <div
          className="motion-safe:animate-pulse motion-reduce:animate-none h-24 rounded-md bg-[var(--ink-surface)]"
          aria-label="正在生成图表"
        />
      )}
    </figure>
  );
}
