'use client';

import type { ReactNode } from 'react';
import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { AlertTriangle, ArrowLeftRight, CheckCircle2, Clock3, GitBranch, RefreshCw, Search } from 'lucide-react';
import { cn } from '@/lib/utils';

type UsageItem = {
  id: string;
  operation: string;
  provider: string;
  requestedModel: string;
  actualModel: string | null;
  fallbackModel: string | null;
  usedFallback: boolean;
  status: string;
  errorKind: string | null;
  inputTokens: number | null;
  outputTokens: number | null;
  latencyMs: number | null;
  createdAt: string;
};

type Breakdown = {
  calls: number;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  fallbackCount: number;
  failureCount: number;
};

type UsageResponse = {
  days: number;
  summary: {
    calls: number;
    inputTokens: number;
    outputTokens: number;
    knownCostCents: number;
    fallbackCount: number;
    failureCount: number;
  };
  operationBreakdown: Array<Breakdown & { operation: string }>;
  modelBreakdown: Array<Breakdown & { model: string }>;
  daily: Array<{
    date: string;
    calls: number;
    totalTokens: number;
    fallbackCount: number;
    failureCount: number;
    knownCostCents: number;
  }>;
  failureBreakdown: Array<{ kind: string; count: number; operations: string[] }>;
  items: UsageItem[];
};

const number = new Intl.NumberFormat('zh-CN');

function token(value: number | null): string { return number.format(value ?? 0); }
function modelLabel(model: string): string { return model.replace(/^anthropic:/u, '').replace(/^openai:/u, ''); }

export default function LlmUsageConsole() {
  const [days, setDays] = useState(7);
  const [search, setSearch] = useState('');
  const [attentionOnly, setAttentionOnly] = useState(false);
  const usage = useQuery<UsageResponse>({
    queryKey: ['admin-llm-usage', days],
    queryFn: async () => {
      const response = await fetch(`/api/admin/llm-usage?days=${days}`, { cache: 'no-store' });
      if (!response.ok) throw new Error('读取 LLM 用量失败');
      return response.json() as Promise<UsageResponse>;
    },
    refetchInterval: 30_000,
  });

  const detailItems = useMemo(() => {
    const query = search.trim().toLowerCase();
    return (usage.data?.items ?? []).filter((item) => {
      if (attentionOnly && !item.usedFallback && item.status === 'succeeded') return false;
      return !query || `${item.operation} ${item.requestedModel} ${item.errorKind ?? ''}`.toLowerCase().includes(query);
    });
  }, [attentionOnly, search, usage.data?.items]);

  if (usage.isLoading) return <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">{[0, 1, 2, 3].map((item) => <div className="h-24 animate-pulse rounded-lg bg-muted" key={item} />)}</div>;
  if (usage.isError || !usage.data) return <div className="rounded-lg border border-red-500/25 bg-red-500/5 p-4 text-sm text-red-700 dark:text-red-300"><div className="flex items-center gap-2"><AlertTriangle className="size-4" />无法读取 LLM 用量审计</div><button className="mt-3 rounded-md border px-3 py-1.5 text-sm hover:bg-muted" onClick={() => usage.refetch()} type="button">重新读取</button></div>;

  const { summary, operationBreakdown, modelBreakdown, daily, failureBreakdown } = usage.data;
  const totalTokens = summary.inputTokens + summary.outputTokens;
  const callCount = Math.max(summary.calls, 1);
  const fallbackRate = Math.round((summary.fallbackCount / callCount) * 100);
  const failureRate = Math.round((summary.failureCount / callCount) * 100);
  const maxDailyTokens = Math.max(1, ...daily.map((item) => item.totalTokens));
  const topFailedOperations = operationBreakdown
    .filter((item) => item.failureCount > 0)
    .sort((a, b) => b.failureCount - a.failureCount)
    .slice(0, 5);

  return (
    <section className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div><h2 className="text-lg font-semibold">Token 消耗</h2><p className="mt-1 text-xs text-muted-foreground">按环节统计实际记录的输入与输出 Token。</p></div>
        <div className="flex items-center gap-1 rounded-md border bg-card p-1">{[1, 7, 30].map((value) => <button className={`rounded px-3 py-1.5 text-xs ${days === value ? 'bg-foreground text-background' : 'text-muted-foreground hover:bg-muted'}`} key={value} onClick={() => setDays(value)} type="button">最近 {value} 天</button>)}<button aria-label="刷新" className="ml-1 rounded p-1.5 text-muted-foreground hover:bg-muted" onClick={() => usage.refetch()} type="button"><RefreshCw className="size-3.5" /></button></div>
      </div>

      <section className="flex flex-col gap-4 rounded-md border border-primary/20 bg-primary/[0.035] p-4 lg:flex-row lg:items-center lg:justify-between">
        <div>
          <h3 className="text-sm font-semibold">运行信号</h3>
          <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
            先看异常和降级，再进入按环节与按模型的明细。
          </p>
        </div>
        <div className="grid grid-cols-3 gap-3 text-right">
          <Signal label="失败率" value={`${failureRate}%`} tone={failureRate > 0 ? 'danger' : 'success'} />
          <Signal label="降级率" value={`${fallbackRate}%`} tone={fallbackRate > 0 ? 'warning' : 'success'} />
          <Signal label="已知成本" value={`$${(summary.knownCostCents / 100).toFixed(2)}`} tone="default" />
        </div>
      </section>

      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4"><SummaryCard label="总 Token" value={token(totalTokens)} /><SummaryCard label="输入 Token" value={token(summary.inputTokens)} /><SummaryCard label="输出 Token" value={token(summary.outputTokens)} /><SummaryCard label="调用 / 降级" value={`${token(summary.calls)} / ${token(summary.fallbackCount)}`} hint={summary.failureCount > 0 ? `失败 ${token(summary.failureCount)} 次` : '没有失败调用'} /></div>

      <section className="rounded-lg border border-border bg-card">
        <div className="border-b border-border px-4 py-3">
          <h3 className="text-sm font-semibold">运行趋势与异常排行</h3>
          <p className="mt-1 text-xs text-muted-foreground">按天观察 Token 峰值，再定位失败最多的环节和原因。</p>
        </div>
        <div className="grid gap-4 p-4 lg:grid-cols-[minmax(0,1.4fr)_minmax(280px,1fr)]">
          <div className="min-w-0 rounded-md bg-muted/25 p-3">
            <div className="flex items-center justify-between gap-3">
              <div>
                <h4 className="text-xs font-semibold">Token 趋势</h4>
                <p className="mt-1 text-[11px] text-muted-foreground">柱高按当前时间范围内的日总 Token 归一化。</p>
              </div>
              <span className="font-mono text-xs tabular-nums text-muted-foreground">{daily.length} 天</span>
            </div>
            {daily.length > 0 ? (
              <>
                <div className="mt-4 flex h-28 items-end gap-1 overflow-hidden" aria-label="每日 Token 趋势">
                  {daily.map((item) => (
                    <div
                      key={item.date}
                      className="group relative flex min-w-0 flex-1 items-end"
                      title={`${formatTrendDate(item.date)} · ${token(item.totalTokens)} Token · 失败 ${item.failureCount} · 降级 ${item.fallbackCount}`}
                    >
                      <div
                        className="w-full min-w-[3px] rounded-t-sm bg-primary/75 transition-colors group-hover:bg-primary"
                        style={{ height: `${Math.max(4, (item.totalTokens / maxDailyTokens) * 100)}%` }}
                      />
                    </div>
                  ))}
                </div>
                <div className="mt-2 flex justify-between text-[11px] text-muted-foreground">
                  <span>{formatTrendDate(daily[0].date)}</span>
                  <span>{formatTrendDate(daily[daily.length - 1].date)}</span>
                </div>
              </>
            ) : (
              <p className="mt-6 text-xs text-muted-foreground">当前时间范围内没有趋势数据。</p>
            )}
          </div>

          <div className="min-w-0 space-y-4">
            <RankingList
              title="失败最多的环节"
              emptyLabel="当前没有失败环节。"
              items={topFailedOperations.map((item) => ({
                label: item.operation,
                value: item.failureCount,
                total: item.calls,
                suffix: '次',
              }))}
            />
            <RankingList
              title="失败原因"
              emptyLabel="当前没有失败原因。"
              items={failureBreakdown.slice(0, 5).map((item) => ({
                label: item.kind,
                value: item.count,
                total: failureBreakdown[0]?.count ?? item.count,
                suffix: '次',
              }))}
            />
          </div>
        </div>
      </section>

      <section className="rounded-lg border border-border bg-card"><div className="border-b border-border px-4 py-3"><h3 className="text-sm font-semibold">按环节汇总</h3><p className="mt-1 text-xs text-muted-foreground">这里是主要查看入口；每一行对应一个业务步骤。</p></div><TableScrollFrame label="按环节汇总"><table className="w-full min-w-[760px] text-left text-sm"><thead className="border-b border-border bg-muted/40 text-xs text-muted-foreground"><tr><th className="sticky left-0 z-10 bg-muted/40 px-4 py-2.5 font-medium">环节</th><th className="px-4 py-2.5 text-right font-medium">调用次数</th><th className="px-4 py-2.5 text-right font-medium">输入 Token</th><th className="px-4 py-2.5 text-right font-medium">输出 Token</th><th className="px-4 py-2.5 text-right font-medium">总 Token</th><th className="px-4 py-2.5 text-right font-medium">降级</th><th className="px-4 py-2.5 text-right font-medium">失败</th></tr></thead><tbody className="divide-y divide-border">{operationBreakdown.map((item) => <tr className="hover:bg-muted/30" key={item.operation}><td className="sticky left-0 z-[1] bg-card px-4 py-3 font-mono text-xs">{item.operation}</td><td className="px-4 py-3 text-right font-mono tabular-nums">{token(item.calls)}</td><td className="px-4 py-3 text-right font-mono tabular-nums">{token(item.inputTokens)}</td><td className="px-4 py-3 text-right font-mono tabular-nums">{token(item.outputTokens)}</td><td className="px-4 py-3 text-right font-mono font-semibold tabular-nums">{token(item.totalTokens)}</td><td className="px-4 py-3 text-right font-mono tabular-nums">{token(item.fallbackCount)}</td><td className="px-4 py-3 text-right font-mono tabular-nums">{token(item.failureCount)}</td></tr>)}{operationBreakdown.length === 0 && <tr><td className="px-4 py-8 text-center text-muted-foreground" colSpan={7}>当前时间范围内没有记录。</td></tr>}</tbody></table></TableScrollFrame></section>

      <div className="grid gap-4 lg:grid-cols-2"><section className="rounded-lg border border-border bg-card"><div className="border-b border-border px-4 py-3"><h3 className="text-sm font-semibold">按模型汇总</h3></div><TableScrollFrame label="按模型汇总"><table className="w-full text-left text-sm"><thead className="border-b border-border bg-muted/40 text-xs text-muted-foreground"><tr><th className="sticky left-0 z-10 bg-muted/40 px-4 py-2.5 font-medium">模型</th><th className="px-4 py-2.5 text-right font-medium">输入</th><th className="px-4 py-2.5 text-right font-medium">输出</th><th className="px-4 py-2.5 text-right font-medium">合计</th></tr></thead><tbody className="divide-y divide-border">{modelBreakdown.map((item) => <tr key={item.model}><td className="sticky left-0 z-[1] bg-card px-4 py-3 font-mono text-xs">{modelLabel(item.model)}</td><td className="px-4 py-3 text-right font-mono tabular-nums">{token(item.inputTokens)}</td><td className="px-4 py-3 text-right font-mono tabular-nums">{token(item.outputTokens)}</td><td className="px-4 py-3 text-right font-mono font-semibold tabular-nums">{token(item.totalTokens)}</td></tr>)}</tbody></table></TableScrollFrame></section><section className="rounded-lg border border-border bg-card"><div className="border-b border-border px-4 py-3"><h3 className="text-sm font-semibold">已知成本</h3></div><div className="px-4 py-4"><div className="text-2xl font-semibold tabular-nums">${(summary.knownCostCents / 100).toFixed(2)}</div><p className="mt-1 text-xs leading-5 text-muted-foreground">只有上游返回价格或主研究引擎提供成本时才会计入；Token 统计不受此限制。</p></div></section></div>

      <section className="rounded-lg border border-border bg-card"><div className="flex flex-wrap items-center justify-between gap-3 border-b border-border px-4 py-3"><div><h3 className="flex items-center gap-2 text-sm font-semibold"><Clock3 className="size-4" />调用明细</h3><p className="mt-1 text-xs text-muted-foreground">显示最新 {usage.data.items.length} 条记录。</p></div><div className="flex items-center gap-2"><label className="relative"><Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" /><input aria-label="搜索环节" className="h-8 w-44 rounded-md border bg-background pl-8 pr-3 text-xs outline-none focus-visible:ring-2 focus-visible:ring-ring" onChange={(event) => setSearch(event.target.value)} placeholder="搜索环节或模型" value={search} /></label><button className={`h-8 rounded-md border px-3 text-xs ${attentionOnly ? 'border-amber-500/50 bg-amber-500/10 text-amber-700 dark:text-amber-300' : 'hover:bg-muted'}`} onClick={() => setAttentionOnly((value) => !value)} type="button">仅看异常</button></div></div><TableScrollFrame label="调用明细"><table className="w-full min-w-[980px] text-left text-xs"><thead className="border-b border-border bg-muted/40 text-muted-foreground"><tr><th className="sticky left-0 z-10 bg-muted/40 px-4 py-2.5 font-medium">时间</th><th className="px-4 py-2.5 font-medium">环节</th><th className="px-4 py-2.5 font-medium">模型</th><th className="px-4 py-2.5 font-medium">状态</th><th className="px-4 py-2.5 text-right font-medium">输入</th><th className="px-4 py-2.5 text-right font-medium">输出</th><th className="px-4 py-2.5 text-right font-medium">延迟</th><th className="px-4 py-2.5 font-medium">备注</th></tr></thead><tbody className="divide-y divide-border">{detailItems.map((item) => <tr className="hover:bg-muted/30" key={item.id}><td className="sticky left-0 z-[1] whitespace-nowrap bg-card px-4 py-3 text-muted-foreground">{new Date(item.createdAt).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false })}</td><td className="px-4 py-3 font-mono">{item.operation}</td><td className="px-4 py-3 font-mono">{modelLabel(item.actualModel ?? item.requestedModel)}</td><td className="px-4 py-3">{item.usedFallback ? <span className="inline-flex items-center gap-1 text-amber-700 dark:text-amber-300"><GitBranch className="size-3" />降级</span> : item.status === 'succeeded' ? <span className="inline-flex items-center gap-1 text-emerald-700 dark:text-emerald-300"><CheckCircle2 className="size-3" />成功</span> : <span className="inline-flex items-center gap-1 text-red-700 dark:text-red-300"><AlertTriangle className="size-3" />失败</span>}</td><td className="px-4 py-3 text-right font-mono tabular-nums">{token(item.inputTokens)}</td><td className="px-4 py-3 text-right font-mono tabular-nums">{token(item.outputTokens)}</td><td className="px-4 py-3 text-right font-mono tabular-nums text-muted-foreground">{item.latencyMs === null ? '—' : `${token(item.latencyMs)} ms`}</td><td className="max-w-56 truncate px-4 py-3 text-muted-foreground">{item.usedFallback ? `fallback → ${modelLabel(item.fallbackModel ?? 'deepseek-v4-flash')}` : item.errorKind ?? '—'}</td></tr>)}{detailItems.length === 0 && <tr><td className="px-4 py-8 text-center text-muted-foreground" colSpan={8}>没有匹配的调用记录。</td></tr>}</tbody></table></TableScrollFrame></section>
    </section>
  );
}

function TableScrollFrame({ children, label }: { children: ReactNode; label: string }) {
  return (
    <div className="overflow-hidden">
      <div className="flex items-center justify-between gap-3 border-b border-border bg-muted/20 px-4 py-2 text-[11px] text-muted-foreground lg:hidden">
        <span>左右滑动查看完整明细</span>
        <ArrowLeftRight className="size-3.5 shrink-0" aria-hidden="true" />
      </div>
      <div
        className="overflow-x-auto focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset"
        role="region"
        aria-label={label}
        tabIndex={0}
      >
        {children}
      </div>
    </div>
  );
}

function SummaryCard({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return <div className="rounded-lg border border-border bg-card p-4"><div className="text-xs text-muted-foreground">{label}</div><div className="mt-2 text-2xl font-semibold tabular-nums">{value}</div>{hint && <div className="mt-1 text-[11px] text-muted-foreground">{hint}</div>}</div>;
}

function RankingList({
  title,
  emptyLabel,
  items,
}: {
  title: string;
  emptyLabel: string;
  items: Array<{ label: string; value: number; total: number; suffix: string }>;
}) {
  const max = Math.max(1, ...items.map((item) => item.value));
  return (
    <div>
      <h4 className="text-xs font-semibold">{title}</h4>
      {items.length === 0 ? (
        <p className="mt-2 text-xs text-muted-foreground">{emptyLabel}</p>
      ) : (
        <div className="mt-2 space-y-2">
          {items.map((item) => (
            <div key={item.label} className="grid grid-cols-[minmax(0,1fr)_auto] gap-3 text-xs">
              <div className="min-w-0">
                <div className="truncate font-mono text-[11px]" title={item.label}>{item.label}</div>
                <div className="mt-1 h-1.5 overflow-hidden rounded-sm bg-muted">
                  <div className="h-full rounded-sm bg-status-failed-fg/70" style={{ width: `${Math.max(4, (item.value / max) * 100)}%` }} />
                </div>
              </div>
              <span className="font-mono tabular-nums text-muted-foreground">
                {token(item.value)}{item.suffix}
                {item.total > item.value ? ` / ${token(item.total)}` : ''}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function formatTrendDate(value: string): string {
  const [, month, day] = value.split('-');
  return month && day ? `${month}/${day}` : value;
}

function Signal({
  label,
  value,
  tone,
}: {
  label: string;
  value: string;
  tone: 'default' | 'success' | 'warning' | 'danger';
}) {
  return (
    <div>
      <div className="text-[11px] text-muted-foreground">{label}</div>
      <div
        className={cn(
          'mt-1 font-mono text-lg font-semibold tabular-nums',
          tone === 'success' && 'text-emerald-700 dark:text-emerald-300',
          tone === 'warning' && 'text-amber-700 dark:text-amber-300',
          tone === 'danger' && 'text-red-700 dark:text-red-300',
        )}
      >
        {value}
      </div>
    </div>
  );
}
