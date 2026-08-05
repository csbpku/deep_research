'use client';

import { useParams } from 'next/navigation';
import { useQuery } from '@tanstack/react-query';
import Link from 'next/link';
import { useState } from 'react';
import {
  ArrowLeft,
  ChevronDown,
  ChevronRight,
  ExternalLink,
  FileText,
  Lightbulb,
  ListChecks,
  PenLine,
  Radar,
} from 'lucide-react';

import { EmptyState } from '@/components/EmptyState';
import { MarkdownPreview } from '@/components/MarkdownPreview';
import { friendlyMessage } from '@/lib/errors/friendly';
import { toApiHttpError } from '@/lib/errors/api-error';
import { retryOnceAi } from '@/lib/errors/friendly';
import { StatusBadge } from '@/components/domain/StatusBadge';
import { Button } from '@/components/ui/button';
import { Progress } from '@/components/ui/progress';
import { Skeleton } from '@/components/ui/skeleton';
import { cn } from '@/lib/utils';

interface AiJobStatus {
  jobId: string;
  status: string;
  finalStatus: string | null;
  currentStep: string | null;
  sourcesCount: number;
  topic: string | null;
  partialSourcesCount: number;
  failedSourcesCount: number;
  errorStage: string | null;
  tokenInputTotal: number;
  tokenOutputTotal: number;
  costCents: number;
  draftResearchId: string | null;
  reportType: string | null;
  outputText: string | null;
  errorCode: string | null;
  errorMessage: string | null;
  startedAt: string | null;
  createdAt: string | null;
  completedAt: string | null;
}

const TERMINAL = new Set(['succeeded', 'failed', 'cancelled', 'partial']);
const STEPS = [
  { key: 'plan', label: '规划', desc: '拆解调研计划', icon: ListChecks },
  { key: 'search', label: '检索', desc: '检索并抓取来源', icon: Radar },
  { key: 'compress', label: '压缩', desc: '压缩检索上下文', icon: FileText },
  { key: 'analyze', label: '分析', desc: '提炼关键事实', icon: Lightbulb },
  { key: 'write', label: '写作', desc: '生成可编辑草稿', icon: PenLine },
] as const;

type StepState = 'done' | 'current' | 'error' | 'waiting';

/**
 * AI 调研任务状态页。
 *
 * 验收 4：每 5s 轮询 /api/ai-research/[jobId]；终态自动停止。
 */
export default function AiJobStatusPage() {
  const params = useParams<{ jobId: string }>();
  const q = useQuery<AiJobStatus>({
    queryKey: ['ai-job', params.jobId],
    queryFn: async () => {
      const r = await fetch(`/api/ai-research/${params.jobId}`, { cache: 'no-store' });
      if (!r.ok) throw await toApiHttpError(r, '加载失败');
      return (await r.json()) as AiJobStatus;
    },
    retry: retryOnceAi,
    refetchInterval: (data) => {
      if (data.state.status === 'error') return false;
      const s = data?.state.data;
      if (!s) return 5_000;
      // 终态停止轮询
      if (s.finalStatus && TERMINAL.has(s.finalStatus)) return false;
      // queued / running 持续 5s 轮询
      return 5_000;
    },
    refetchIntervalInBackground: false,
  });

  return (
    <div className="mx-auto max-w-shell">
      <Button asChild variant="link" size="xs" className="mb-2 h-auto p-0">
        <Link href="/ai-research">
          <ArrowLeft />
          返回 AI 调研
        </Link>
      </Button>

      <h1 className="text-xl font-semibold tracking-tight">
        {q.isError
          ? '无法加载调研'
          : q.data?.finalStatus && TERMINAL.has(q.data.finalStatus)
            ? '调研结果'
            : '调研进行中'}
      </h1>
      <p className="mt-1 text-xs text-muted-foreground">
        {q.data?.topic ?? '本次调研'}
      </p>

      <div className="mt-4">
        {q.isLoading ? (
          <Skeleton className="h-64 w-full" />
        ) : q.isError ? (
          <EmptyState title="加载失败" description={friendlyMessage(q.error, '请稍后重试')} />
        ) : q.data ? (
          <StatusBody s={q.data} />
        ) : null}
      </div>
    </div>
  );
}

function StatusBody({ s }: { s: AiJobStatus }) {
  const finalStatus = s.finalStatus;
  const isTerminal = finalStatus && TERMINAL.has(finalStatus);
  const pct = progressPct(s);
  const elapsed = formatElapsed(s);
  const statusLabel = finalStatus ?? s.status;
  const activeIdx = stepIndex(s.currentStep ?? s.errorStage);
  const isBrief = s.reportType === 'summary_brief';

  return (
    <div className="overflow-hidden rounded-lg border border-border bg-card">
      {/* Header */}
      <div className="flex flex-wrap items-start justify-between gap-4 border-b border-border p-4">
        <div className="min-w-0">
          <h2 className="text-base font-semibold leading-snug">{s.topic ?? 'AI 调研任务'}</h2>
          <div className="mt-2.5 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
            <StatusBadge kind="job" value={statusLabel} label={statusLabel} />
            {activeIdx >= 0 ? (
              <span className="font-mono">
                步骤 {STEPS[activeIdx].label} ({activeIdx + 1}/{STEPS.length})
              </span>
            ) : null}
            <span>已耗时 {elapsed}</span>
            {!isTerminal ? (
              <span>{isBrief ? '完成后在本页显示摘要' : '完成后可打开私有草稿'}</span>
            ) : null}
          </div>
        </div>
        <div className="shrink-0 text-right">
          <div className="font-mono text-3xl font-bold leading-none tabular-nums text-primary">
            {pct}%
          </div>
          <div className="mt-1 text-xs text-muted-foreground">完成进度</div>
        </div>
      </div>

      {/* Progress bar */}
      <div className="border-b border-border px-4 pb-4">
        <Progress value={Math.min(100, Math.max(0, pct))} />
      </div>

      {/* Pipeline steps */}
      <div className="grid grid-cols-2 gap-2 p-4 sm:grid-cols-3 lg:grid-cols-5">
        {STEPS.map((step, idx) => (
          <StepCard
            key={step.key}
            step={step}
            state={stepState(s, idx)}
            count={countForStep(s, step.key)}
          />
        ))}
      </div>

      {/* 状态详情 —— 默认折叠，只露一行概括，避免运行时 debug 字段污染主屏 */}
      <JobStatusDisclosure s={s} elapsed={elapsed} />

      {finalStatus === 'partial' ? (
        <div
          role="alert"
          className="border-t border-border bg-status-partial-bg p-4 text-sm text-status-partial-fg"
        >
          <strong className="font-medium">部分结果可用</strong>
          {s.errorCode ? <span className="ml-2 font-mono text-xs">{s.errorCode}</span> : null}
          <p className="mt-1.5 text-xs opacity-90">
            任务以部分完成状态结束：已抓取的资料会保留，但不会生成可发布的草稿；重新尝试会创建一条新的调研任务。
          </p>
        </div>
      ) : s.errorCode ? (
        <div
          role="alert"
          className="border-t border-border bg-status-failed-bg p-4 text-sm text-status-failed-fg"
        >
          <strong className="font-mono font-medium">{s.errorCode}</strong>
          {s.errorMessage ? <span className="ml-2">{s.errorMessage}</span> : null}
        </div>
      ) : null}

      {finalStatus === 'succeeded' && isBrief && s.outputText ? (
        <section className="border-t border-border p-4" aria-label="轻量摘要结果">
          <h3 className="mb-3 text-sm font-semibold">轻量摘要</h3>
          <MarkdownPreview source={s.outputText} />
        </section>
      ) : null}

      {!isTerminal ? (
        <p className="border-t border-border p-4 text-sm text-muted-foreground">
          {isBrief
            ? '轻量摘要不会创建调研草稿。'
            : '完成后草稿只会出现在「我的草稿」，不会直接进入调研库。'}
        </p>
      ) : null}

      {isTerminal ? (
        <div className="flex flex-wrap items-center justify-between gap-3 border-t border-border p-4">
          <div className="text-sm">
            {finalStatus === 'succeeded' ? (
              <span className="text-status-succeeded-fg">
                {isBrief ? '轻量摘要已生成，未创建调研草稿。' : '调研完成，私有草稿仅你本人可见。'}
              </span>
            ) : finalStatus === 'partial' ? (
              <span className="text-status-partial-fg">任务已部分完成，已保留抓取资料但未生成草稿。</span>
            ) : finalStatus === 'failed' ? (
              <span className="text-status-failed-fg">任务失败，可以回到提交页重新发起。</span>
            ) : (
              <span className="text-muted-foreground">任务已撤回。</span>
            )}
          </div>
          <div className="flex flex-wrap gap-2">
            {finalStatus === 'succeeded' && s.draftResearchId ? (
              <Button asChild size="sm">
                <Link href={`/researches/${s.draftResearchId}/edit`}>
                  <ExternalLink />
                  打开私有草稿
                </Link>
              </Button>
            ) : null}
            <Button asChild variant="outline" size="sm">
              <Link href="/ai-research">重新调研</Link>
            </Button>
          </div>
        </div>
      ) : null}
    </div>
  );
}

function stepIndex(step: string | null | undefined): number {
  if (!step) return -1;
  const idx = STEPS.findIndex((s) => s.key === step);
  return idx;
}

function stepLabel(step: string | null | undefined): string {
  if (!step) return '—';
  return STEPS.find((item) => item.key === step)?.label ?? '处理中';
}

function progressPct(s: AiJobStatus): number {
  if (s.finalStatus === 'succeeded') return 100;
  if (s.status === 'queued' || s.finalStatus === 'queued') return 5;
  const idx = stepIndex(s.currentStep ?? s.errorStage);
  if (idx >= 0) return (idx + 1) * 20;
  return s.finalStatus && TERMINAL.has(s.finalStatus) ? 100 : 10;
}

function formatElapsed(s: AiJobStatus): string {
  const start = s.startedAt ?? s.createdAt;
  if (!start) return '—';
  const end = s.completedAt ?? new Date().toISOString();
  const ms = new Date(end).getTime() - new Date(start).getTime();
  if (Number.isNaN(ms) || ms < 0) return '—';
  const sec = Math.floor(ms / 1000);
  if (sec < 60) return `${sec}s`;
  return `${Math.floor(sec / 60)}m ${sec % 60}s`;
}

function stepState(s: AiJobStatus, idx: number): StepState {
  const stepKey = STEPS[idx].key;
  const activeIdx = stepIndex(s.currentStep ?? s.errorStage);
  if (s.finalStatus === 'succeeded') return 'done';
  if (s.errorStage === stepKey && (s.finalStatus === 'failed' || s.finalStatus === 'partial')) return 'error';
  if (s.finalStatus === 'cancelled') return activeIdx > idx ? 'done' : 'waiting';
  if (activeIdx > idx) return 'done';
  if (activeIdx === idx) return s.finalStatus === 'failed' || s.finalStatus === 'partial' ? 'error' : 'current';
  return 'waiting';
}

function countForStep(s: AiJobStatus, stepKey: string): string | null {
  if (stepKey === 'search' && s.partialSourcesCount > 0) {
    return `${s.partialSourcesCount} 条资料`;
  }
  if (stepKey === 'write' && s.finalStatus === 'succeeded') {
    return s.reportType === 'summary_brief' ? '已生成摘要' : '已生成草稿';
  }
  if (s.errorStage === stepKey && s.errorCode) {
    return s.errorCode;
  }
  return null;
}

/** 步骤状态 → token 化配色。 */
const STEP_CLASSES: Record<StepState, string> = {
  done: 'border-status-succeeded-fg/30 bg-status-succeeded-bg text-status-succeeded-fg',
  current: 'border-status-running-fg/30 bg-status-running-bg text-status-running-fg',
  error: 'border-status-failed-fg/30 bg-status-failed-bg text-status-failed-fg',
  waiting: 'border-border bg-card text-muted-foreground',
};

const STEP_LABELS: Record<StepState, string> = {
  done: '完成',
  current: '当前步骤',
  error: '失败',
  waiting: '等待中',
};

function StepCard({
  step,
  state,
  count,
}: {
  step: (typeof STEPS)[number];
  state: StepState;
  count: string | null;
}) {
  const Icon = step.icon;
  return (
    <div className={cn('min-w-0 rounded-md border p-2.5', STEP_CLASSES[state])}>
      <div className="flex items-center gap-1.5">
        <Icon aria-hidden className="size-3.5 shrink-0" />
        <span className="text-xs font-semibold">{step.label}</span>
      </div>
      <div className="mt-1 text-xs opacity-85">{STEP_LABELS[state]}</div>
      {count ? (
        <div className="mt-1 truncate text-xs" title={count}>
          {count}
        </div>
      ) : null}
      <div className="mt-1 truncate text-[10px] opacity-60" title={step.desc}>
        {step.desc}
      </div>
    </div>
  );
}

function DetailRow({ label, value, mono = false }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="flex min-w-0 gap-1.5">
      <span className="shrink-0 text-muted-foreground">{label}:</span>
      <span className={cn('truncate', mono && 'font-mono tabular-nums')}>{value}</span>
    </div>
  );
}

/**
 * 任务状态详情 disclosure —— 默认折叠，只露一行关键摘要。
 *
 * 默认信息：耗时 + 费用 + 令牌 + 当前步骤 —— 工程师排错时一眼可见。
 * 完整字段（已抓取 / 失败 / 出错于 / 完整 ID）藏在展开后。
 *
 * 与 ScoreReasonDisclosure 同样的设计：debug 字段不该污染主屏，需要时再展开。
 */
function JobStatusDisclosure({
  s,
  elapsed,
}: {
  s: AiJobStatus;
  elapsed: string;
}) {
  const [open, setOpen] = useState(false);
  const summary =
    `${elapsed} · 费用 $${(s.costCents / 100).toFixed(2)}` +
    ` · 令牌 ${s.tokenInputTotal} / ${s.tokenOutputTotal}` +
    (s.currentStep ? ` · 当前 ${stepLabel(s.currentStep)}` : '');

  return (
    <div className="border-t border-border">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="flex w-full cursor-pointer items-center justify-between gap-2 px-4 py-2 text-left transition-colors duration-150 hover:bg-muted/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        <span className="flex items-center gap-1.5 text-xs font-medium uppercase tracking-wide text-muted-foreground">
          {open ? (
            <ChevronDown className="size-3.5" aria-hidden />
          ) : (
            <ChevronRight className="size-3.5" aria-hidden />
          )}
          状态详情
        </span>
        <span className="truncate font-mono text-xs text-muted-foreground">{summary}</span>
      </button>
      {open && (
        <div className="grid gap-x-4 gap-y-2 border-t border-border bg-muted/40 px-4 py-3 text-xs sm:grid-cols-2 lg:grid-cols-3">
          <DetailRow label="正在处理" value={stepLabel(s.currentStep)} />
          <DetailRow label="已抓取" value={String(s.partialSourcesCount)} mono />
          <DetailRow label="抓取失败" value={String(s.failedSourcesCount)} mono />
          <DetailRow label="出错于" value={stepLabel(s.errorStage)} />
          <DetailRow label="耗时" value={elapsed} mono />
          <DetailRow label="费用" value={`$${(s.costCents / 100).toFixed(2)}`} mono />
          <DetailRow label="令牌 输入/输出" value={`${s.tokenInputTotal} / ${s.tokenOutputTotal}`} mono />
        </div>
      )}
    </div>
  );
}
