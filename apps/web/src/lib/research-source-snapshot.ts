import { createHash } from 'node:crypto';

export type SourceSnapshotRow = { canonicalKey: string; sourceRef: unknown; title: string | null; description: string | null };
export function codepointCompare(a: string, b: string): number {
  const aa = Array.from(a, (x) => x.codePointAt(0)!); const bb = Array.from(b, (x) => x.codePointAt(0)!);
  for (let i = 0; i < Math.min(aa.length, bb.length); i++) if (aa[i] !== bb[i]) return aa[i]! - bb[i]!;
  return aa.length - bb.length;
}
export function stableSourceJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableSourceJson).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.entries(value as Record<string, unknown>).sort(([a], [b]) => codepointCompare(a, b)).map(([k, v]) => `${JSON.stringify(k)}:${stableSourceJson(v)}`).join(',')}}`;
  return JSON.stringify(value);
}
export function hashCanonicalSourceSnapshot(sources: SourceSnapshotRow[], partial?: unknown): string {
  const mixed = matchingCapturedSnapshot(sources, partial);
  const payload = mixed ?? sources.map((s) => ({ canonicalKey: s.canonicalKey, sourceRef: s.sourceRef, title: s.title, snippet: s.description }))
    .sort((a, b) => codepointCompare(a.canonicalKey, b.canonicalKey));
  return createHash('sha256').update(stableSourceJson(payload), 'utf8').digest('hex');
}

type CapturedSource = { canonicalKey: string; sourceRef: Record<string, string | boolean>; title: string | null; snippet: string | null };
function clip(value: string | null, limit: number): string | null {
  if (value === null || Array.from(value).length <= limit) return value;
  return `${Array.from(value).slice(0, limit - 1).join('').trimEnd()}…`;
}
export function matchingCapturedSnapshot(preview: SourceSnapshotRow[], partial: unknown): CapturedSource[] | null {
  if (!Array.isArray(partial) || !partial.length || !preview.length) return null;
  const captured = new Map<string, CapturedSource>();
  const duplicates = new Set<string>();
  for (const item of partial) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
    const row = item as Record<string, unknown>;
    const key = row.canonical_key ?? row.canonicalKey; const ref = row.source_ref ?? row.sourceRef;
    if (typeof key !== 'string' || !ref || typeof ref !== 'object' || Array.isArray(ref) ||
        !Object.keys(ref).length || Object.values(ref).some((v) => typeof v !== 'string' && typeof v !== 'boolean') ||
        !(row.title === null || typeof row.title === 'string') || typeof row.snippet !== 'string' || !row.snippet.trim()) continue;
    if (captured.has(key)) { captured.delete(key); duplicates.add(key); continue; }
    if (!duplicates.has(key)) captured.set(key, { canonicalKey: key, sourceRef: ref as Record<string, string | boolean>, title: row.title, snippet: row.snippet });
  }
  let upgraded = false;
  const combined: CapturedSource[] = [];
  for (const source of preview) {
    if (!source.sourceRef || typeof source.sourceRef !== 'object' || Array.isArray(source.sourceRef) ||
        !Object.keys(source.sourceRef).length || Object.values(source.sourceRef).some((v) => typeof v !== 'string' && typeof v !== 'boolean')) return null;
    const saved = captured.get(source.canonicalKey);
    const match = saved && stableSourceJson(source.sourceRef) === stableSourceJson(saved.sourceRef) &&
      source.title === clip(saved.title, 300) && source.description === clip(saved.snippet, 1000);
    if (match) upgraded = true;
    combined.push({ canonicalKey: source.canonicalKey, sourceRef: source.sourceRef as Record<string, string | boolean>,
      title: source.title, snippet: match ? saved.snippet : source.description });
  }
  return upgraded ? combined.sort((a, b) => codepointCompare(a.canonicalKey, b.canonicalKey)) : null;
}
