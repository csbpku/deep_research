/**
 * A comparison matrix is only a comparison if every cell says where it came
 * from. Prose can hedge; a table cell cannot, because readers scan it as fact.
 */
export interface ComparisonMatrixIssue {
  row: string;
  column: string;
  text: string;
}

export interface ComparisonMatrixCheck {
  present: boolean;
  rows: number;
  columns: number;
  unmarked: ComparisonMatrixIssue[];
}

export type ComparisonCellStatus = 'evidence' | 'partial' | 'unknown' | 'conflict';

export interface ComparisonCell {
  text: string;
  citations: string[];
  status: ComparisonCellStatus;
}

export interface ComparisonMatrix {
  dimensions: string[];
  rows: { option: string; cells: ComparisonCell[] }[];
  counts: Record<ComparisonCellStatus, number>;
}

const EVIDENCE = /\[S\d+\]/gu;
const EXPLICIT_GAP = /未知|待实测|未确认|冲突|未找到|无直接证据|未核验|没有证据/u;
const PARTIAL = /部分|仅覆盖|未完全|尚未|有限/u;

function cells(line: string): string[] {
  return line.trim().replace(/^\|/u, '').replace(/\|$/u, '').split('|').map(cell => cell.trim());
}

export function checkComparisonMatrix(body: string): ComparisonMatrixCheck {
  const lines = String(body ?? '').split(/\r?\n/u);
  const start = lines.findIndex(line => /^##\s+对比矩阵\s*$/u.test(line.trim()));
  if (start < 0) return { present: false, rows: 0, columns: 0, unmarked: [] };

  let header: string[] | null = null;
  const unmarked: ComparisonMatrixIssue[] = [];
  let rows = 0;
  for (let index = start + 1; index < lines.length; index++) {
    const line = lines[index].trim();
    if (line.startsWith('## ')) break;
    if (!line.startsWith('|')) continue;
    const row = cells(line);
    if (row.every(cell => /^:?-{2,}:?$/u.test(cell))) continue;
    if (!header) { header = row; continue; }
    rows += 1;
    row.forEach((cell, column) => {
      if (column === 0) return;
      if (!cell) return;
      if (EVIDENCE.test(cell) || EXPLICIT_GAP.test(cell)) return;
      unmarked.push({ row: row[0] || `第 ${rows} 行`, column: header?.[column] || `第 ${column + 1} 列`, text: cell.slice(0, 120) });
    });
  }
  return { present: true, rows, columns: Math.max(0, (header?.length ?? 0) - 1), unmarked };
}


function classify(text: string, citations: string[]): ComparisonCellStatus {
  if (/冲突|矛盾|不一致/u.test(text)) return 'conflict';
  if (citations.length > 0) return PARTIAL.test(text) ? 'partial' : 'evidence';
  if (PARTIAL.test(text)) return 'partial';
  return 'unknown';
}

export function parseComparisonMatrix(body: string): ComparisonMatrix | null {
  const lines = String(body ?? '').split(/\r?\n/u);
  const start = lines.findIndex(line => /^##\s+对比矩阵\s*$/u.test(line.trim()));
  if (start < 0) return null;
  let header: string[] | null = null;
  const rows: { option: string; cells: ComparisonCell[] }[] = [];
  const counts: Record<ComparisonCellStatus, number> = { evidence: 0, partial: 0, unknown: 0, conflict: 0 };
  for (let index = start + 1; index < lines.length; index++) {
    const line = lines[index].trim();
    if (line.startsWith('## ')) break;
    if (!line.startsWith('|')) continue;
    const row = cells(line);
    if (row.every(cell => /^:?-{2,}:?$/u.test(cell))) continue;
    if (!header) { header = row; continue; }
    const option = row[0] || `第 ${rows.length + 1} 行`;
    const parsed = row.slice(1).map(cell => {
      const citations = [...cell.matchAll(EVIDENCE)].map(match => match[0]);
      const text = cell
        .replace(EVIDENCE, '')
        .replace(/\*\*(有证据|待实测|未知|冲突)\*\*[:：]?/gu, '')
        .replace(/\s{2,}/gu, ' ')
        .trim();
      const status = classify(cell, citations);
      counts[status] += 1;
      return { text: text || '未知', citations, status };
    });
    rows.push({ option, cells: parsed });
  }
  if (!header || rows.length === 0) return null;
  return { dimensions: header.slice(1), rows, counts };
}
