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
// Writers sometimes emit bare labels ("S1", "S2S3") inside a matrix cell. Treat
// them as citations instead of silently dropping the evidence and calling the
// cell "unknown".
const BARE_CITATION = /(?<![\w[])S\d+(?:S\d+)*/gu;

function bracketBareCitations(cell: string): string {
  return cell.replace(BARE_CITATION, (match) => match.split(/(?=S\d)/u).map(part => `[${part}]`).join(''));
}
const HAS_EVIDENCE = /\[S\d+\]/u;
const EXPLICIT_GAP = /未知|待实测|未确认|冲突|未找到|无直接证据|未核验|没有证据/u;
const PARTIAL = /部分|仅覆盖|未完全|尚未|有限/u;

function cells(line: string): string[] {
  return line.trim().replace(/^\|/u, '').replace(/\|$/u, '').split('|').map(cell => cell.trim());
}

function firstTableLines(lines: string[], start: number): string[] {
  const table: string[] = [];
  for (let index = start + 1; index < lines.length; index++) {
    const raw = lines[index];
    const line = raw.trim();
    if (line.startsWith('|')) {
      table.push(line);
      continue;
    }
    if (table.length === 0 && line === '') continue;
    // A second table after a blank line or prose is a different artifact:
    // only the first table is the matrix.
    break;
  }
  return table;
}

export function checkComparisonMatrix(body: string): ComparisonMatrixCheck {
  const lines = String(body ?? '').split(/\r?\n/u);
  const start = lines.findIndex(line => /^##\s+对比矩阵\s*$/u.test(line.trim()));
  if (start < 0) return { present: false, rows: 0, columns: 0, unmarked: [] };

  const table = firstTableLines(lines, start);
  let header: string[] | null = null;
  const unmarked: ComparisonMatrixIssue[] = [];
  let rows = 0;
  for (const line of table) {
    const row = cells(line).map(bracketBareCitations);
    if (row.every(cell => /^:?-{2,}:?$/u.test(cell))) continue;
    if (!header) { header = row; continue; }
    rows += 1;
    const width = Math.max((header?.length ?? 1) - 1, row.length - 1);
    for (let column = 1; column <= width; column++) {
      const cell = row[column] ?? '';
      const label = header?.[column] || `第 ${column + 1} 列`;
      if (!cell) {
        unmarked.push({ row: row[0] || `第 ${rows} 行`, column: label, text: '表格缺少这一维度' });
        continue;
      }
      if (HAS_EVIDENCE.test(cell) || EXPLICIT_GAP.test(cell)) continue;
      unmarked.push({ row: row[0] || `第 ${rows} 行`, column: label, text: cell.slice(0, 120) });
    }
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
  const table = firstTableLines(lines, start);
  let header: string[] | null = null;
  const rows: { option: string; cells: ComparisonCell[] }[] = [];
  const counts: Record<ComparisonCellStatus, number> = { evidence: 0, partial: 0, unknown: 0, conflict: 0 };
  for (const line of table) {
    const row = cells(line).map(bracketBareCitations);
    if (row.every(cell => /^:?-{2,}:?$/u.test(cell))) continue;
    if (!header) { header = row; continue; }
    const option = row[0] || `第 ${rows.length + 1} 行`;
    const parsed: ComparisonCell[] = row.slice(1).map(cell => {
      const citations = [...cell.matchAll(EVIDENCE)].map(match => match[0]);
      const text = cell
        .replace(EVIDENCE, '')
        .replace(/\*\*(有证据|待实测|未知|冲突)\*\*[:：]?/gu, '')
        .replace(/\s{2,}/gu, ' ')
        .trim();
      const status = classify(cell, citations);
      return { text: text || '未知', citations, status };
    });
    // A short row must not silently shift columns: pad it with an explicit gap
    // so the phone card can still label every dimension.
    const dimensions = (header ?? []).slice(1);
    const complete = dimensions.map((_, index) => parsed[index] ?? {
      text: '未知（表格没有给出这一维度）',
      citations: [],
      status: 'unknown' as const,
    });
    for (const cell of complete) counts[cell.status] += 1;
    rows.push({ option, cells: complete });
  }
  if (!header || rows.length === 0) return null;
  return { dimensions: header.slice(1), rows, counts };
}

/**
 * Comparison is an artifact choice, not a softer decision memo: the reader
 * asked for differences, not a winner. Prompts already say this, but prompts
 * are advisory; this check makes the boundary enforceable at publish time.
 */
const RECOMMENDATION = /(?:建议|推荐|应当|应该)(?:选择|采用|使用|优先)|优先选择|推荐方案/gu;
const NEGATED = /(?:不|不要|无需|没有|禁止|避免)(?:建议|推荐)|不建议|不推荐/u;

export function findRecommendationLanguage(body: string): string[] {
  const hits: string[] = [];
  for (const line of String(body ?? '').split(/\r?\n/u)) {
    if (!RECOMMENDATION.test(line)) continue;
    RECOMMENDATION.lastIndex = 0;
    if (NEGATED.test(line)) continue;
    hits.push(line.trim().slice(0, 160));
  }
  return hits;
}
