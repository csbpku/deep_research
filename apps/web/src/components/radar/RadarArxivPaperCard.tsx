// Phase 2B — Radar deep-dive: arxiv paper structured view.
//
// Reference layout: Google PAIR/lumi (https://lumi.withgoogle.com).
// Sections:
//   1. Paper header — title + authors + arxiv id + categories
//   2. TL;DR card — AI one-sentence summary + key contributions
//   3. Section navigator — left rail with click-to-scroll
//   4. Figures grid — placeholder; figures metadata not yet shipped
//
// Pure presentational — receives already-parsed data from the BFF.
// No client-side fetching. The PDF markdown is rendered in a <pre>
// block for P0; a proper markdown renderer is a future polish.

interface Section {
  title: string;
  level: number;
  startOffset: number;
  page?: number;
}

interface Figure {
  page: number;
  caption?: string;
  // base64 dataUrl optional; we don't ship in P0 (BFF strips)
  dataUrl?: string;
}

interface ArxivMeta {
  provider?: string;
  arxivId?: string;
  fetchedAt?: string;
  keyContributions?: string[];
  sectionCount?: number;
}

interface Props {
  meta: ArxivMeta;
  title: string;
  authors: string[];
  tldr: string | null;
  sections: Section[];
  figures: Figure[];
  markdown: string | null;
}

function formatAuthors(authors: string[]): string {
  if (authors.length === 0) return '';
  if (authors.length === 1) return authors[0]!;
  if (authors.length <= 3) return authors.join(', ');
  return `${authors.slice(0, 3).join(', ')} 等`;
}

export function RadarArxivPaperCard({
  meta,
  title,
  authors,
  tldr,
  sections,
  figures,
  markdown,
}: Props) {
  const topLevelSections = sections.filter((s) => s.level === 1);

  return (
    <section
      data-testid="arxiv-paper-card"
      style={{
        border: '1px solid #e2e8f0',
        borderRadius: 10,
        background: '#fff',
        overflow: 'hidden',
        marginBottom: 16,
      }}
    >
      {/* Paper header */}
      <div
        style={{
          padding: '14px 18px',
          background: 'linear-gradient(135deg, #7c3aed 0%, #4f46e5 100%)',
          color: '#f1f5f9',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
          <span style={{ fontSize: 18 }}>📄</span>
          <span style={{ fontWeight: 600, fontSize: 16, lineHeight: 1.4 }}>{title}</span>
        </div>
        <div style={{ fontSize: 12, color: '#e0e7ff', marginBottom: 4 }}>
          {formatAuthors(authors)}
        </div>
        {meta.arxivId && (
          <div style={{ fontSize: 11, color: '#c7d2fe' }}>
            arXiv:{meta.arxivId}
          </div>
        )}
      </div>

      {/* TL;DR card */}
      {tldr && (
        <div
          style={{
            padding: '12px 18px',
            background: '#faf5ff',
            borderBottom: '1px solid #e2e8f0',
          }}
        >
          <div
            style={{
              fontSize: 11,
              fontWeight: 600,
              color: '#7c3aed',
              marginBottom: 6,
              textTransform: 'uppercase',
              letterSpacing: 0.5,
            }}
          >
            TL;DR
          </div>
          <p style={{ fontSize: 14, color: '#1e293b', lineHeight: 1.6, margin: 0 }}>
            {tldr}
          </p>
          {meta.keyContributions && meta.keyContributions.length > 0 && (
            <div style={{ marginTop: 10 }}>
              <div
                style={{
                  fontSize: 11,
                  fontWeight: 600,
                  color: '#7c3aed',
                  marginBottom: 4,
                }}
              >
                KEY CONTRIBUTIONS
              </div>
              <ul style={{ margin: 0, paddingLeft: 18, fontSize: 13, color: '#334155' }}>
                {meta.keyContributions.map((c, i) => (
                  <li key={i} style={{ marginBottom: 3, lineHeight: 1.5 }}>
                    {c}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}

      {/* Section navigator + figures grid */}
      {(topLevelSections.length > 0 || figures.length > 0) && (
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: topLevelSections.length > 0 ? '180px 1fr' : '1fr',
            borderBottom: '1px solid #e2e8f0',
          }}
        >
          {topLevelSections.length > 0 && (
            <nav
              style={{
                padding: '12px 14px',
                background: '#f8fafc',
                borderRight: '1px solid #e2e8f0',
              }}
            >
              <div
                style={{
                  fontSize: 11,
                  fontWeight: 600,
                  color: '#475569',
                  marginBottom: 8,
                  textTransform: 'uppercase',
                  letterSpacing: 0.5,
                }}
              >
                目录 ({topLevelSections.length})
              </div>
              <ol style={{ margin: 0, padding: 0, listStyle: 'none' }}>
                {topLevelSections.map((s, i) => (
                  <li
                    key={i}
                    style={{
                      fontSize: 12,
                      color: '#334155',
                      padding: '3px 0',
                      lineHeight: 1.4,
                      borderLeft: '2px solid #cbd5e1',
                      paddingLeft: 6,
                      marginBottom: 2,
                    }}
                  >
                    {s.title}
                  </li>
                ))}
              </ol>
            </nav>
          )}
          <div style={{ padding: '12px 18px' }}>
            {figures.length > 0 ? (
              <div>
                <div
                  style={{
                    fontSize: 12,
                    fontWeight: 600,
                    color: '#475569',
                    marginBottom: 8,
                  }}
                >
                  🖼️ 图表 ({figures.length})
                </div>
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(160px, 1fr))', gap: 8 }}>
                  {figures.slice(0, 8).map((f, i) => (
                    <div
                      key={i}
                      style={{
                        border: '1px solid #e2e8f0',
                        borderRadius: 6,
                        padding: 8,
                        background: '#f8fafc',
                        fontSize: 11,
                        color: '#64748b',
                        textAlign: 'center',
                      }}
                    >
                      {f.dataUrl ? (
                        <img
                          src={f.dataUrl}
                          alt={f.caption ?? `Figure p.${f.page}`}
                          style={{ maxWidth: '100%', height: 'auto', borderRadius: 4 }}
                        />
                      ) : (
                        <div style={{ padding: '20px 8px', color: '#94a3b8' }}>
                          Figure p.{f.page}
                        </div>
                      )}
                      {f.caption && (
                        <div style={{ marginTop: 4, fontSize: 10 }}>
                          {f.caption}
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              </div>
            ) : (
              <div style={{ fontSize: 13, color: '#94a3b8', textAlign: 'center', padding: 16 }}>
                图表列表待 PDF 抽取后填充
              </div>
            )}
          </div>
        </div>
      )}

      {/* PDF markdown preview */}
      {markdown && (
        <details style={{ padding: '12px 18px' }}>
          <summary
            style={{
              cursor: 'pointer',
              fontSize: 12,
              fontWeight: 600,
              color: '#475569',
              marginBottom: 8,
            }}
          >
            📖 论文正文（前 10 页，markdown）
          </summary>
          <pre
            style={{
              whiteSpace: 'pre-wrap',
              fontSize: 13,
              color: '#1e293b',
              lineHeight: 1.6,
              maxHeight: 400,
              overflowY: 'auto',
              background: '#f8fafc',
              padding: 12,
              borderRadius: 6,
              margin: 0,
              fontFamily: 'inherit',
            }}
          >
            {markdown.slice(0, 12_000)}
            {markdown.length > 12_000 ? '\n\n[…后续内容省略]' : ''}
          </pre>
        </details>
      )}
    </section>
  );
}