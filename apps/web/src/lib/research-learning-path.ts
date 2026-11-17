/** A learning path is only a path when its concept map has enough nodes. */
export interface LearningPathCheck {
  present: boolean;
  concepts: number;
  issues: string[];
}

const PRESENT = /^##\s+概念图\s*$/mu;

function rows(body: string): string[][] {
  const lines = body.split(/\r?\n/u);
  const start = lines.findIndex(line => PRESENT.test(line.trim()));
  if (start < 0) return [];
  const out: string[][] = [];
  for (let index = start + 1; index < lines.length; index++) {
    const line = lines[index].trim();
    if (line.startsWith('## ')) break;
    if (!line.startsWith('|')) continue;
    const cells = line.replace(/^\|/u, '').replace(/\|$/u, '').split('|').map(cell => cell.trim());
    if (cells.every(cell => /^:?-{2,}:?$/u.test(cell))) continue;
    out.push(cells);
  }
  return out;
}

const PLACEHOLDERS = /^(?:[-—/]|无|不适用|相关|有关|见上文|略)$/u;

function relationIsSpecific(row: string[]): boolean {
  const relation = row[2]?.replace(/[`*]/gu, '').trim() ?? '';
  if (relation.length < 6 || PLACEHOLDERS.test(relation)) return false;
  const definition = row[1]?.replace(/[`*]/gu, '').trim() ?? '';
  return relation !== definition;
}

export function checkLearningPath(body: string): LearningPathCheck {
  const table = rows(body);
  if (table.length === 0) return { present: false, concepts: 0, issues: [] };
  const data = table.slice(1);
  const issues: string[] = [];
  if (data.length < 4 || data.length > 6) issues.push(`概念图需要 4–6 个概念，当前 ${data.length} 个`);
  for (const row of data) {
    if (!row[0]) issues.push('概念图存在空概念名');
    if (!row[2] || /^[-—/]$/u.test(row[2])) {
      issues.push(`概念「${row[0] || '未命名'}」缺少与其他概念的关系`);
      continue;
    }
    if (row[0] && row[0].length > 0 && !relationIsSpecific(row)) {
      issues.push(`概念「${row[0]}」的关系过于笼统，无法说明它与其他概念如何关联`);
    }
  }
  return { present: true, concepts: data.length, issues };
}
