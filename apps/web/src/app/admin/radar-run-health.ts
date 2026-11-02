type Run = { sourceId: string; sourceType: string; status: string; totalFetched: number };

/** Runs arrive newest first; empty RSS responses are a signal, not proof of failure. */
export function consecutiveEmptyRuns(runs: Run[]): Map<string, number> {
  const counts = new Map<string, number>();
  const closed = new Set<string>();
  for (const run of runs) {
    if (run.sourceType !== 'rss' || closed.has(run.sourceId)) continue;
    if (!counts.has(run.sourceId)) counts.set(run.sourceId, 0);
    if (run.status !== 'completed' || run.totalFetched !== 0) {
      closed.add(run.sourceId);
    } else {
      counts.set(run.sourceId, (counts.get(run.sourceId) ?? 0) + 1);
    }
  }
  return counts;
}
