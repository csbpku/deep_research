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

const EVIDENCE = /\[S\d+\]/u;
const EXPLICIT_GAP = /未知|待实测|未确认|冲突|未找到|无直接证据|未核验|没有证据/u;

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
