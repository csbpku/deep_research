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
export function hashCanonicalSourceSnapshot(sources: SourceSnapshotRow[]): string {
  const payload = sources.map((s) => ({ canonicalKey: s.canonicalKey, sourceRef: s.sourceRef, title: s.title, snippet: s.description }))
    .sort((a, b) => codepointCompare(a.canonicalKey, b.canonicalKey));
  return createHash('sha256').update(stableSourceJson(payload), 'utf8').digest('hex');
}
