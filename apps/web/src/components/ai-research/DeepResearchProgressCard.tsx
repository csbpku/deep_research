'use client';

import { AlertTriangle, Loader2, Radar } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';

import type { DeepResearchProgress } from '@/lib/ai-progress';
import { cn } from '@/lib/utils';

export function DeepResearchProgressCard({
  progress,
  savedSources,
  capturedSources = 0,
  compact = false,
  summaryOnly = false,
  gaps = [],
  terminalStatus = null,
  reviewStatus = null,
}: {
  progress: DeepResearchProgress | null | undefined;
  /** Persisted source rows, including URL-only discoveries. */
  savedSources: number;
  /** Sources with an inspectable body excerpt. Never infer this from savedSources. */
  capturedSources?: number;
  /** Keep the running view focused on the next useful user decision. */
  summaryOnly?: boolean;
  /** User-facing evidence gaps projected by the task page. */
  gaps?: string[];
  compact?: boolean;
  terminalStatus?: string | null;
  /** Publication can finish after the report is written but before review passes. */
  reviewStatus?: string | null;
}) {
  const activityKey = progress?.mode === 'deep' ? [
    progress.state,
    progress.round,
    progress.rounds,
    progress.totalBranchesCompleted ?? progress.branchesCompleted,
    progress.totalBranches ?? progress.branchesTotal,
    progress.pagesVisited,
    progress.sourcesDiscovered,
    progress.sourcesCaptured,
    progress.currentFocus?.trim(),
    progress.adaptive?.followupGroupsStarted,
    progress.adaptive?.followupGroupsCompleted,
    progress.adaptive?.stalledGroups,
    progress.adaptive?.stoppedEarly,
    progress.adaptive?.stopReason,
    progress.collectionTimedOut,
    progress.collectionTimeboxSeconds,
    progress.retrieval?.attempts,
    progress.retrieval?.emptyResults,
    progress.retrieval?.failed,
  ].join('|') : 'inactive';
  const lastActivityKeyRef = useRef(activityKey);
  const lastActivityAtRef = useRef(Date.now());
  const [clock, setClock] = useState(() => Date.now());

  useEffect(() => {
    if (lastActivityKeyRef.current === activityKey) return;
    lastActivityKeyRef.current = activityKey;
    lastActivityAtRef.current = Date.now();
    setClock(lastActivityAtRef.current);
  }, [activityKey]);

  useEffect(() => {
    if (progress?.state === 'completed') return;
    const timer = window.setInterval(() => setClock(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [progress?.state]);

  if (!progress || progress.mode !== 'deep') return null;

  const total = progress.totalBranches ?? progress.branchesTotal ?? 0;
  const completed = Math.min(
    progress.totalBranchesCompleted ?? progress.branchesCompleted ?? 0,
    total || Number.MAX_SAFE_INTEGER,
  );
  const currentRoundTotal = progress.branchesTotal ?? 0;
  const currentRoundCompleted = Math.min(progress.branchesCompleted ?? 0, currentRoundTotal || Number.MAX_SAFE_INTEGER);
  const cumulativeCompleted = progress.totalBranchesCompleted ?? currentRoundCompleted;
  const round = progress.round && progress.rounds ? `第 ${progress.round}/${progress.rounds} 轮` : '多轮检索';
  const allBranchesComplete = total > 0 && completed >= total;
  const terminal = terminalStatus === 'succeeded'
    || terminalStatus === 'partial'
    || terminalStatus === 'failed'
    || terminalStatus === 'cancelled';
  const publicationNeedsReview = terminalStatus === 'succeeded'
    && reviewStatus !== null
    && reviewStatus !== 'passed';
  const adaptive = progress.adaptive;
  const collectionTimeboxed = progress.collectionTimedOut === true;
  const stopReasonLabel = adaptive?.stopReason === 'evidence_sufficient'
    ? '证据已够，提前综合'
    : adaptive?.stopReason === 'no_new_evidence'
      ? '连续无新增证据，已收敛'
      : adaptive?.stopReason === 'followup_budget_reached'
        ? '达到补查上限，开始综合'
        : null;
  const followupGroupsCompleted = adaptive?.followupGroupsCompleted ?? 0;
  const followupLabel = followupGroupsCompleted > 0
    ? `已补查 ${followupGroupsCompleted} 组证据缺口${stopReasonLabel ? ` · ${stopReasonLabel}` : ''}`
    : stopReasonLabel;
  const branchLabel = adaptive?.stoppedEarly && stopReasonLabel
    ? `累计完成 ${cumulativeCompleted} 个方向 · ${stopReasonLabel}`
    : currentRoundTotal > 0
      ? `本轮完成 ${currentRoundCompleted}/${currentRoundTotal} 个方向 · 累计 ${cumulativeCompleted} 个`
      : '正在拆分研究主题';
  // This is an execution-time evidence repair pass, not the independent
  // fact-review result. Keep the legacy field name for persisted jobs, but do
  // not present it as a second fact-review counter in the UI.
  const evidenceGapRepair = progress.claimGapRepair;
  const isRepairingEvidence = evidenceGapRepair?.state === 'repairing';
  const evidenceGapLabel = evidenceGapRepair && evidenceGapRepair.remaining > 0
    ? `仍有 ${evidenceGapRepair.remaining} 个证据缺口`
    : evidenceGapRepair && evidenceGapRepair.resolved > 0
      ? `已补查 ${evidenceGapRepair.resolved} 个证据缺口`
      : null;
  const reportWriteFallback = progress.reportWriteFallback;
  const state = terminal
    ? terminalStatus === 'succeeded'
      ? publicationNeedsReview ? '研究稿已生成，依据待整理' : '已完成'
      : terminalStatus === 'partial'
        ? '已停止，资料已保留'
        : terminalStatus === 'cancelled'
          ? '已取消'
          : '未完成'
    : isRepairingEvidence
    ? '正在补查证据缺口'
    : collectionTimeboxed
    ? '检索时间盒已到，正在先生成报告'
    : progress.state === 'completed'
    ? '已完成'
    : progress.state === 'reviewing'
      ? '正在整理依据'
    : progress.state === 'writing'
      ? '正在生成研究稿'
    : progress.state === 'verifying'
      ? '正在补查证据缺口'
    : progress.state === 'analyzing'
      ? '正在整理证据'
      : progress.state === 'planning'
        ? '正在规划研究主题'
        : allBranchesComplete
          ? '分支完成，正在整理'
      : '正在检索';
  const focus = progress.currentFocus?.trim();
  const discovered = Math.max(progress.sourcesDiscovered ?? 0, savedSources);
  const captured = Math.max(progress.sourcesCaptured ?? 0, capturedSources);
  // These are different observations. A source can be discovered without its
  // page being opened, and a bounded evidence ledger can contain fewer rows
  // than the number of pages touched. Never infer page visits from either.
  const visited = typeof progress.pagesVisited === 'number' ? progress.pagesVisited : null;
  const visitedLabel = visited === null ? '已打开页面未记录' : `${visited} 个已打开页面`;
  const coverage = Object.values(progress.sourceCoverage ?? {});
  const coveredProducts = coverage.filter((item) => item.status === 'covered').length;
  const retrieval = progress.retrieval;
  const retrievalDegraded = !!retrieval && (
    retrieval.retrievalDegraded || retrieval.emptyResults > 0 || retrieval.failed > 0
  );
  const selectedProvider = retrieval?.selectedProvider;
  const retrievalLabel = retrievalDegraded
    ? '部分检索暂时没有返回有效资料，系统正在补查；这些结果不会被用于支撑结论。'
    : null;
  const idleSeconds = Math.max(0, Math.floor((clock - lastActivityAtRef.current) / 1000));
  // Once the tree has handed off to writing or fact review, an unchanged
  // progress snapshot is expected. Showing a "slow evidence" warning there
  // makes a healthy publication step look stuck and contradicts the phase
  // label above. Only the evidence-producing phases can genuinely be waiting
  // on a source response.
  const waitingForEvidence = !terminal && !compact
    && ['planning', 'searching', 'verifying', 'analyzing'].includes(progress.state ?? '')
    && idleSeconds >= 30;

  if (summaryOnly) {
    const roundProgress = currentRoundTotal > 0
      ? `${currentRoundCompleted}/${currentRoundTotal} 个方向`
      : round;
    const nextStep = progress.state === 'planning'
      ? '拆分研究方向'
      : progress.state === 'searching'
        ? '继续获取可核对正文'
        : progress.state === 'verifying'
          ? '补查证据缺口'
          : progress.state === 'analyzing'
            ? '整理证据并形成对比'
            : progress.state === 'writing'
              ? '生成研究稿'
              : progress.state === 'reviewing'
                ? '整理结果依据'
                : '继续研究并在证据足够时收敛';
    const gap = gaps[0] ?? (
      captured < discovered
        ? `核对剩余 ${discovered - captured} 条检索线索`
        : '继续覆盖尚未完成的研究方向'
    );

    return (
      <section
        className="mt-4 rounded-md border border-primary/15 bg-primary/[0.035] px-4 py-3"
        aria-label="研究进度摘要"
      >
        <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
          <div className="flex min-w-0 flex-wrap items-center gap-2 text-xs">
            <span className="font-semibold text-foreground">正在研究</span>
            <span className="truncate text-muted-foreground">{round}</span>
          </div>
          <span className="text-[11px] text-muted-foreground">{state}</span>
        </div>
        <div className="mt-3 grid grid-cols-3 gap-2" aria-label="研究覆盖摘要">
          <SummaryMetric label="方向" value={roundProgress} />
          <SummaryMetric label="检索线索" value={discovered} />
          <SummaryMetric label="可引用证据" value={captured} emphasized />
        </div>
        <div className="mt-3 grid gap-1 text-[11px] leading-5">
          <p className="truncate">
            <span className="font-medium text-foreground">当前：</span>
            <span className="text-muted-foreground">{focus || state}</span>
          </p>
          <p className="truncate">
            <span className="font-medium text-foreground">还需要：</span>
            <span className="text-muted-foreground">{gap}</span>
          </p>
          <p className="truncate">
            <span className="font-medium text-foreground">下一步：</span>
            <span className="text-muted-foreground">{nextStep}</span>
          </p>
        </div>
        {retrievalDegraded ? (
          <div className="mt-3 flex items-start gap-1.5 rounded-md border border-warning-border/60 bg-warning-bg/35 px-2.5 py-2 text-[11px] leading-5 text-warning-fg" role="status">
            <AlertTriangle className="mt-0.5 size-3.5 shrink-0" aria-hidden />
            <span>{retrievalLabel}</span>
          </div>
        ) : null}
      </section>
    );
  }

  if (compact) {
    return (
      <details
        className="mt-3 rounded-lg border border-primary/15 bg-primary/[0.035]"
        aria-label="研究细节"
      >
        <summary className="flex cursor-pointer list-none items-center justify-between gap-2 px-3 py-2.5 text-[11px] [&::-webkit-details-marker]:hidden">
          <span className="inline-flex items-center gap-1.5 font-medium text-foreground">
            <Radar className="size-3.5 text-primary" />
            研究细节
          </span>
          <span className="truncate text-muted-foreground">{round} · {state}</span>
        </summary>
        <div className="border-t border-primary/10 px-3 pb-3 pt-2.5">
          <div className="grid grid-cols-2 gap-1.5 sm:grid-cols-4" aria-label="深度调研统计">
            <ResearchMetric label="已完成方向" value={cumulativeCompleted} emphasized />
            <ResearchMetric label="已打开页面" value={visited ?? '—'} />
            <ResearchMetric label="可引用证据" value={captured} emphasized />
            <ResearchMetric label="检索线索" value={discovered} />
          </div>
          {discovered > 0 ? (
            <p className={cn('mt-1.5 text-[10px] leading-4', captured < discovered ? 'text-warning-fg' : 'text-muted-foreground')}>
              可引用证据：{captured}/{discovered} 条检索线索已有可核对正文
              {captured < discovered ? '；其余仍只是线索。' : '。'}
            </p>
          ) : null}
          <div className="mt-2 rounded-md border border-border/70 bg-background/60 px-2.5 py-2 text-[11px] leading-5">
            <span className="font-medium text-foreground">当前研究方向：</span>
            <span className="text-muted-foreground">{terminal
              ? terminalStatus === 'partial'
                ? '任务在生成报告前停止；已保留本轮实际抓取的正文'
              : terminalStatus === 'succeeded'
                  ? publicationNeedsReview
                    ? '检索与写作已完成，关键结论还需要确认'
                    : collectionTimeboxed
                    ? '检索达到时间盒，已基于现有证据完成综合'
                    : '本轮研究已收敛'
                  : '本轮研究已结束'
              : focus || (adaptive?.stoppedEarly && stopReasonLabel) || '正在拆分并行研究方向'}</span>
          </div>
          <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-[10px] leading-4 text-muted-foreground">
            {currentRoundTotal > 0 ? <span>本轮 {currentRoundCompleted}/{currentRoundTotal} 个方向</span> : null}
            {coverage.length > 0 ? <span>官方资料已覆盖 {coveredProducts}/{coverage.length} 个产品</span> : null}
            {followupLabel ? <span>{followupLabel}</span> : null}
            {evidenceGapLabel ? <span className="text-warning-fg">{evidenceGapLabel}</span> : null}
          </div>
          {collectionTimeboxed ? (
            <p className="mt-1.5 text-[10px] leading-4 text-warning-fg">
              检索已达到本轮时间盒{progress.collectionTimeboxSeconds ? `（${progress.collectionTimeboxSeconds} 秒）` : ''}；已停止继续扩展研究树，正在基于现有证据生成报告。
            </p>
          ) : null}
          {retrievalDegraded ? (
            <div className="mt-2 flex items-start gap-1.5 text-[10px] leading-4 text-warning-fg" title="部分搜索轮次没有返回结果；这些轮次不会被当作证据">
              <AlertTriangle className="mt-0.5 size-3 shrink-0" aria-hidden />
              <span>
                {retrievalLabel} {captured > 0 ? `当前仍可核对 ${captured} 条正文。` : ''}
              </span>
            </div>
          ) : null}
        </div>
      </details>
    );
  }

  return (
    <section
      className={compact
        ? 'rounded-lg border border-primary/15 bg-primary/[0.035] px-3 py-2.5'
        : 'mt-4 rounded-md border border-primary/15 bg-primary/[0.035] px-4 py-3'}
      aria-label="深度调研进度"
    >
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 text-xs" aria-live="polite">
        <span className="inline-flex items-center gap-1.5 font-medium text-foreground">
          <Radar className="size-3.5 text-primary" />
          深度调研
        </span>
        <span className="text-primary">{round}</span>
        <span className="text-muted-foreground">{branchLabel}</span>
        <span className="text-muted-foreground">· {state}</span>
      </div>
      <p className="mt-1 text-[10px] leading-4 text-muted-foreground">
        先按产品和证据主题分别覆盖多个角度；只有证据不足或出现新缺口时才会继续追查，证据够了就收敛。
      </p>
      {followupLabel ? (
        <p className="mt-1.5 text-[11px] leading-5 text-muted-foreground">
          研究树：{followupLabel}。补查只针对尚未解决的证据缺口，不会把重复搜索计入有效证据。
        </p>
      ) : null}
      <div className="mt-2 grid grid-cols-2 gap-1.5 text-[11px] sm:grid-cols-4" aria-label="研究覆盖统计">
        <ResearchMetric label="已完成方向" value={cumulativeCompleted} emphasized />
        <ResearchMetric label="已打开页面" value={visited ?? '—'} />
        <ResearchMetric label="检索线索" value={discovered} />
        <ResearchMetric label="可引用证据" value={captured} emphasized />
      </div>
      <p className="mt-1.5 text-[10px] leading-4 text-muted-foreground">
        检索线索只是研究树中的候选页面；可引用证据表示已打开并取得可核对正文。没有记录页面数时不做推算；数字本身不能单独证明结论正确。
      </p>
      {discovered > 0 ? (
        <p className={cn('mt-1.5 text-[10px] leading-4', captured < discovered ? 'text-warning-fg' : 'text-muted-foreground')}>
          可引用证据：{captured}/{discovered} 条检索线索已有可核对正文
          {captured < discovered ? '；其余仍只是线索。' : '。'}
        </p>
      ) : null}
      {selectedProvider ? (
        <p className="mt-1.5 text-[10px] leading-4 text-muted-foreground">
          已启用联网检索；相同问题会复用结果，服务波动时自动切换备用检索。
        </p>
      ) : null}
      {retrievalDegraded ? (
        <p className="mt-1.5 flex items-start gap-1.5 text-[10px] leading-4 text-warning-fg" title="部分搜索轮次没有返回结果；这些轮次不会被当作证据">
          <AlertTriangle className="mt-0.5 size-3 shrink-0" aria-hidden />
          <span>{retrievalLabel} {captured > 0 ? `当前仍可核对 ${captured} 条正文。` : ''}</span>
        </p>
      ) : null}
      {focus && !terminal ? (
        <p className="mt-1.5 line-clamp-2 text-[11px] leading-5 text-muted-foreground">
          当前方向：{focus}
        </p>
      ) : null}
      {waitingForEvidence ? (
        <div className="mt-2 flex items-start gap-2 rounded-lg border border-border/70 bg-background/60 px-2.5 py-2 text-[11px] leading-5 text-muted-foreground" role="status">
          <Loader2 className="mt-0.5 size-3.5 shrink-0 animate-spin text-primary" aria-hidden />
          <p>
            {idleSeconds >= 90
              ? `当前资料响应较慢，已等待约 ${Math.floor(idleSeconds / 60)} 分钟；任务仍在后台运行，已抓取的证据会保留。`
              : '当前资料响应较慢；深度检索仍在等待可核对正文，已抓取的证据会持续保留。'}
          </p>
        </div>
      ) : null}
      {coverage.length > 0 ? (
        <div className="mt-2 flex flex-wrap items-center gap-1.5 text-[11px]" aria-label="官方资料覆盖">
          <span className="text-muted-foreground">官方资料覆盖</span>
          {coverage.map((item) => {
            const required = item.requiredCaptured ?? 2;
            const state = item.status === 'covered'
              ? '已覆盖'
              : item.status === 'partial'
                ? '部分证据'
                : item.status === 'pending'
                  ? '已发现，待确认'
                  : '尚未覆盖';
            return (
              <span
                key={item.label}
                className={cn(
                  'rounded-full border px-2 py-0.5',
                  item.status === 'covered'
                    ? 'border-status-succeeded-border bg-status-succeeded-bg text-status-succeeded-fg'
                    : item.status === 'pending' || item.status === 'partial'
                      ? 'border-warning-border bg-warning-bg text-warning-fg'
                      : 'border-border bg-background text-muted-foreground',
                )}
                title={`${item.label}：${item.discovered} 个独立页面，已抓取 ${item.captured} 条正文；至少需要 ${required} 条`}
              >
                {item.label} · {state}{item.captured > 0 ? ` ${item.status === 'covered' ? `${item.captured} 条` : `${item.captured}/${required}`}` : ''}
              </span>
            );
          })}
        </div>
      ) : null}
      {progress.coverageRepair && progress.coverageRepair.attempted > 0 ? (
        <p className="mt-1.5 text-[10px] leading-4 text-muted-foreground">
          已针对证据不足的产品补查 {progress.coverageRepair.attempted} 个官方入口，新增 {progress.coverageRepair.captured} 条已抓取正文。
        </p>
      ) : null}
      {collectionTimeboxed ? (
        <p className="mt-1.5 text-[10px] leading-4 text-warning-fg">
          检索已达到本轮时间盒{progress.collectionTimeboxSeconds ? `（${progress.collectionTimeboxSeconds} 秒）` : ''}；后续报告只基于已抓取正文，不会把未打开的线索当成证据。
        </p>
      ) : null}
      {evidenceGapRepair && evidenceGapRepair.attempted > 0 ? (
        <p className="mt-1.5 text-[10px] leading-4 text-muted-foreground">
          研究阶段已补查 {evidenceGapRepair.resolved} 个证据缺口；
          {evidenceGapRepair.remaining > 0 ? `仍有 ${evidenceGapRepair.remaining} 个未解决，结果中会提示需要确认。` : '本轮没有遗留研究资料缺口。'}
        </p>
      ) : null}
      {reportWriteFallback ? (
        <p className="mt-1.5 text-[10px] leading-4 text-warning-fg">
          {reportWriteFallback.reason === 'timeout'
            ? `主报告写作超过 ${reportWriteFallback.timeoutSeconds ?? 180} 秒，`
            : '主报告写作未返回有效正文，'}
          已根据本轮实际抓取的证据重写；若仍缺少结论，会明确标记为需要确认。
        </p>
      ) : null}
      {retrievalDegraded ? (
        <div className="mt-2 flex gap-2 rounded-lg border border-warning-border/60 bg-warning-bg/40 px-2.5 py-2 text-[11px] leading-5 text-warning-fg" role="status">
          <AlertTriangle className="mt-0.5 size-3.5 shrink-0" aria-hidden />
          <p>
            {retrievalLabel} 当前仍可核对 {captured} 条正文。
          </p>
        </div>
      ) : null}
    </section>
  );
}

function ResearchMetric({
  label,
  value,
  emphasized = false,
}: {
  label: string;
  value: number | string;
  emphasized?: boolean;
}) {
  return (
    <div className="rounded-md border border-border/70 bg-background/70 px-2 py-1.5">
      <div className="font-mono text-sm font-semibold tabular-nums text-foreground">{value}</div>
      <div className={cn('mt-0.5', emphasized ? 'font-medium text-primary' : 'text-muted-foreground')}>{label}</div>
    </div>
  );
}

function SummaryMetric({
  label,
  value,
  emphasized = false,
}: {
  label: string;
  value: number | string;
  emphasized?: boolean;
}) {
  return (
    <div className="min-w-0 rounded-md border border-border/70 bg-background/70 px-2.5 py-2">
      <div className={cn('truncate font-mono text-sm font-semibold tabular-nums', emphasized ? 'text-primary' : 'text-foreground')}>
        {value}
      </div>
      <div className="mt-0.5 truncate text-[10px] text-muted-foreground">{label}</div>
    </div>
  );
}
