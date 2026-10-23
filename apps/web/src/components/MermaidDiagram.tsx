'use client';

import { useEffect, useId, useState } from 'react';
import { keyframes } from '@emotion/react';
import Box from '@mui/material/Box';
import { tokensFor, type DesignTokens } from '@deep-research/design-system';

const mermaidPulse = keyframes`
  50% { opacity: 0.5; }
`;

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

function readSharedColor(key: keyof DesignTokens, fallback: string): string {
  const variable = `--dr-${key}`;
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
        const shared = tokensFor(dark ? 'dark' : 'light');
        const page = readSharedColor('color-surface', shared['color-surface']);
        const surface = readSharedColor('color-surface-container', shared['color-surface-container']);
        const text = readSharedColor('color-text', shared['color-text']);
        const muted = readSharedColor('color-text-secondary', shared['color-text-secondary']);
        const accent = readSharedColor('color-primary', shared['color-primary']);
        const outline = readSharedColor('color-outline', shared['color-outline']);
        mermaid.initialize({
          startOnLoad: false,
          securityLevel: 'strict',
          theme: 'base',
          fontFamily: shared['font-family'],
          themeVariables: {
            primaryColor: surface,
            primaryTextColor: text,
            primaryBorderColor: accent,
            lineColor: muted,
            secondaryColor: page,
            tertiaryColor: surface,
            clusterBkg: page,
            clusterBorder: outline,
            edgeLabelBackground: page,
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
      <Box
        sx={{
          my: 'var(--dr-space-5)',
          overflow: 'hidden',
          border: '1px solid color-mix(in srgb, var(--dr-color-warning) 70%, var(--dr-color-outline))',
          borderRadius: 'var(--dr-radius-small)',
          backgroundColor: 'color-mix(in srgb, var(--dr-color-warning-container) 60%, transparent)',
          color: 'var(--dr-color-warning)',
        }}
      >
        <details>
          <Box
            component="summary"
            sx={{
              cursor: 'pointer',
              px: 'var(--dr-space-4)',
              py: 'var(--dr-space-2)',
              fontSize: 'var(--dr-type-caption)',
              fontWeight: 'var(--dr-weight-medium)',
              color: 'var(--dr-color-warning)',
              '&:focus-visible': {
                outline: '2px solid var(--dr-color-primary)',
                outlineOffset: '2px',
              },
            }}
          >
            图表暂时无法绘制，查看原始图表文本
          </Box>
          <Box
            component="pre"
            sx={{
              overflow: 'auto',
              whiteSpace: 'pre-wrap',
              overflowWrap: 'anywhere',
              borderTop: '1px solid color-mix(in srgb, var(--dr-color-warning) 60%, var(--dr-color-outline))',
              m: 0,
              px: 'var(--dr-space-4)',
              py: 'var(--dr-space-3)',
              fontSize: 'var(--dr-type-caption)',
              lineHeight: 2,
              color: 'var(--dr-color-warning)',
            }}
          >
            {chart}
          </Box>
        </details>
      </Box>
    );
  }

  return (
    <Box
      component="figure"
      sx={{
        my: 'var(--dr-space-6)',
        overflowX: 'auto',
        border: '1px solid var(--dr-color-outline)',
        borderRadius: 'var(--dr-radius-small)',
        backgroundColor: 'var(--dr-color-surface)',
        px: 'var(--dr-space-4)',
        py: 'var(--dr-space-5)',
      }}
      aria-label="Mermaid 图表"
    >
      {svg ? (
        <Box
          sx={{
            display: 'flex',
            minWidth: 'fit-content',
            justifyContent: 'center',
            '& > svg': { height: 'auto', maxWidth: '100%' },
          }}
          dangerouslySetInnerHTML={{ __html: svg }}
        />
      ) : (
        <Box
          sx={{
            height: 'calc(var(--dr-space-8) + var(--dr-space-8) + var(--dr-space-8))',
            borderRadius: 'var(--dr-radius-small)',
            backgroundColor: 'var(--dr-color-surface-container)',
            animation: `${mermaidPulse} 1.5s cubic-bezier(0.4, 0, 0.6, 1) infinite`,
            '@media (prefers-reduced-motion: reduce)': { animation: 'none' },
          }}
          aria-label="正在生成图表"
        />
      )}
    </Box>
  );
}
