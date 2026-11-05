type Usage = { inputTokens: number | null; outputTokens: number | null; costCents: number | null };

/** A zero-cent record cannot distinguish a free call from a sub-cent or unpriced call. */
export function costCoverage(items: Usage[]): { costReportedCalls: number; costUnavailableCalls: number } {
  let costReportedCalls = 0;
  let costUnavailableCalls = 0;
  for (const item of items) {
    if ((item.costCents ?? 0) > 0) costReportedCalls++;
    else if ((item.inputTokens ?? 0) + (item.outputTokens ?? 0) > 0) costUnavailableCalls++;
  }
  return { costReportedCalls, costUnavailableCalls };
}

export function formatKnownCost(cents: number, unavailableCalls: number): string {
  return cents === 0 && unavailableCalls > 0 ? '未记录' : `$${(cents / 100).toFixed(2)}`;
}
