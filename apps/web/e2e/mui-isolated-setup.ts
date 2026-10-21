import { isolatedMuiOrigin } from './mui-local-fixtures';

/** Read-only identity preflight before any password/session writes. */
export default async function setup() {
  const origin = isolatedMuiOrigin();
  const response = await fetch(`${origin}/api/topics?limit=80`, { signal: AbortSignal.timeout(5000) });
  if (!response.ok) throw new Error(`Isolated fixture preflight failed: HTTP ${response.status}`);
  const data = await response.json() as { items?: Array<{ slug: string }>; total?: number };
  const expected = Array.from({ length: 6 }, (_, i) => `mui-topic-${i + 1}`).sort();
  const actual = (data.items ?? []).map(item => item.slug).sort();
  if (data.total !== 6 || JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error('Not the dedicated MUI fixture service: refusing to authenticate or run UI tests');
  }
}
