/**
 * Read the human-facing `## 覆盖检查` table that intent contracts ask the
 * writer to emit. The table is still authored prose, so this parser is
 * deliberately conservative: it only recognises a real Markdown table with a
 * question and a status column, and maps a small, explicit status vocabulary.
 */
export type IntentCoverageStatus = 'evidence' | 'partial' | 'unknown' | 'conflict';

export interface IntentCoverageRow {
  question: string;
  status: IntentCoverageStatus;
  rawStatus: string;
  evidence: string;
}

export interface IntentCoverage {
  present: true;
  rows: IntentCoverageRow[];
  counts: Record<IntentCoverageStatus, number>;
}

const HEADING = /^#{2,3}\s*覆盖检查\s*$/u;
const NEXT_HEADING = /^#{2,3}\s+\S/u;
const SEPARATOR = /^\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)+\|?$/u;

function classify(raw: string, evidence: string): IntentCoverageStatus {
  const text = raw.toLowerCase();
  if (/冲突|矛盾|反证|contradict/u.test(text)) return 'conflict';
  if (/部分|不完整|partially|partial/u.test(text)) return 'partial';
  if (/有证据|已覆盖|已确认|有依据|evidence|covered/u.test(text)) {
    if (/未知|缺口|未确认|gaps?|unknown/u.test(text)) return 'partial';
    // A "有证据" status with a qualified evidence cell is not full coverage.
    // The table is self-authored; keep the caveat rather than the label.
    if (/部分|尚未|未覆盖|未交叉核验|仍需|仅覆盖/u.test(evidence)) return 'partial';
    return 'evidence';
  }
  return 'unknown';
}

function cells(line: string): string[] {
  return line
    .trim()
    .replace(/^\|/u, '')
    .replace(/\|$/u, '')
    .split('|')
    .map(cell => cell.trim());
}

export function parseIntCoverage(body: string): IntentCoverage | null {
  const lines = String(body ?? '').split(/\r?\n/u);
  const start = lines.findIndex(line => HEADING.test(line.trim()));
  if (start < 0) return null;

  const rows: IntentCoverageRow[] = [];
  for (const line of lines.slice(start + 1)) {
    const trimmed = line.trim();
    if (NEXT_HEADING.test(trimmed)) break;
    if (!trimmed.startsWith('|') || SEPARATOR.test(trimmed)) continue;
    const parts = cells(trimmed);
    if (parts.length < 2) continue;
    // Skip the header row; its second cell is the literal column label.
    if (/^(状态|结论|是否有证据)$/u.test(parts[1]) || /必答问题/u.test(parts[0])) continue;
    const question = parts[0];
    if (!question) continue;
    const rawStatus = parts[1];
    rows.push({
      question,
      status: classify(rawStatus, parts[2] ?? ''),
      rawStatus,
      evidence: parts[2] ?? '',
    });
  }

  if (rows.length === 0) return null;

  const counts: Record<IntentCoverageStatus, number> = {
    evidence: 0, partial: 0, unknown: 0, conflict: 0,
  };
  for (const row of rows) counts[row.status] += 1;
  return { present: true, rows, counts };
}

/** Unknown or conflicting must-answer questions need an explicit publication ack. */
export function hasBlockingIntentCoverage(
  coverage: IntentCoverage | null | undefined,
): boolean {
  return Boolean(coverage && (coverage.counts.unknown + coverage.counts.conflict > 0));
}

/** Partial coverage is disclosed too, but it is not an unanswered question. */
export function hasDisclosableIntentCoverage(
  coverage: IntentCoverage | null | undefined,
): boolean {
  // A missing table is not a disclosure by itself: legacy research reports
  // predate the contract. Intent artifacts, which must have it, handle that
  // case in the publish route.
  if (!coverage) return false;
  return coverage.counts.unknown + coverage.counts.conflict + coverage.counts.partial > 0;
}

/** Accept a coverage snapshot read back from JSON without trusting its shape. */
export function coerceIntentCoverage(value: unknown): IntentCoverage | null {
  if (!value || typeof value !== 'object') return null;
  const record = value as Record<string, unknown>;
  if (record.present !== true || !Array.isArray(record.rows) || !record.counts || typeof record.counts !== 'object') return null;
  const counts = record.counts as Record<string, unknown>;
  const valid = ['evidence', 'partial', 'unknown', 'conflict'].every(
    status => typeof counts[status] === 'number',
  );
  if (!valid) return null;
  return value as IntentCoverage;
}
