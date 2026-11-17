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

export function checkLearningPath(body: string): LearningPathCheck {
  const table = rows(body);
  if (table.length === 0) return { present: false, concepts: 0, issues: [] };
  const data = table.slice(1);
  const issues: string[] = [];
  if (data.length < 4 || data.length > 6) issues.push(`概念图需要 4–6 个概念，当前 ${data.length} 个`);
  for (const row of data) {
    if (!row[0]) issues.push('概念图存在空概念名');
    if (!row[2] || row[2].length < 4 || /^[-—/]$/u.test(row[2])) {
      issues.push(`概念「${row[0] || '未命名'}」缺少与其他概念的关系`);
    }
  }
  return { present: true, concepts: data.length, issues };
}
