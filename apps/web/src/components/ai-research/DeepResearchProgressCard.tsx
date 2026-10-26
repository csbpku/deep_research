'use client';

import { AlertTriangle, Radar } from 'lucide-react';
import React, { useEffect, useRef, useState } from 'react';

import type { DeepResearchProgress } from '@/lib/ai-progress';
import Box from '@mui/material/Box';
import CircularProgress from '@mui/material/CircularProgress';
import Paper from '@mui/material/Paper';
import Typography from '@mui/material/Typography';

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
      <Box
        component="section"
        sx={{ mt: 2, border: 1, borderColor: 'divider', borderRadius: 1, bgcolor: 'background.paper', px: 2, py: 1.5 }}
        aria-label="研究进度摘要"
      >
        <Box sx={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', justifyContent: 'space-between', columnGap: 1.5, rowGap: 0.5 }}>
          <Box sx={{ display: 'flex', minWidth: 0, flexWrap: 'wrap', alignItems: 'center', gap: 1, typography: 'metadata' }}>
            <Typography component="span" variant="metadata" sx={{ fontWeight: 600, color: 'text.primary' }}>正在研究</Typography>
            <Typography component="span" variant="metadata" sx={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', color: 'text.secondary' }}>{round}</Typography>
          </Box>
          <Typography component="span" variant="metadata" color="text.secondary">{state}</Typography>
        </Box>
        <Box sx={{ mt: 1.5, display: 'grid', gridTemplateColumns: 'repeat(3, minmax(0, 1fr))', gap: 1 }} aria-label="研究覆盖摘要">
          <SummaryMetric label="方向" value={roundProgress} />
          <SummaryMetric label="检索线索" value={discovered} />
          <SummaryMetric label="可引用证据" value={captured} emphasized />
        </Box>
        <Box sx={{ mt: 1.5, display: 'grid', gap: 0.5, typography: 'metadata', lineHeight: 1.6 }}>
          <Typography component="p" variant="metadata" noWrap><Box component="span" sx={{ fontWeight: 500, color: 'text.primary' }}>当前：</Box><Box component="span" sx={{ color: 'text.secondary' }}>{focus || state}</Box></Typography>
          <Typography component="p" variant="metadata" noWrap><Box component="span" sx={{ fontWeight: 500, color: 'text.primary' }}>还需要：</Box><Box component="span" sx={{ color: 'text.secondary' }}>{gap}</Box></Typography>
          <Typography component="p" variant="metadata" noWrap><Box component="span" sx={{ fontWeight: 500, color: 'text.primary' }}>下一步：</Box><Box component="span" sx={{ color: 'text.secondary' }}>{nextStep}</Box></Typography>
        </Box>
        {retrievalDegraded ? (
          <Box sx={{ mt: 1.5, display: 'flex', alignItems: 'flex-start', gap: 1, border: 1, borderColor: 'warning.main', borderRadius: 1, bgcolor: 'var(--dr-color-warning-container)', px: 1.5, py: 1, typography: 'metadata', lineHeight: 1.6, color: 'warning.main' }} role="status">
            <Box component="span" sx={{ mt: 0.5, display: 'inline-flex', flexShrink: 0 }}><AlertTriangle size={14} aria-hidden /></Box>
            <Box component="span">{retrievalLabel}</Box>
          </Box>
        ) : null}
      </Box>
    );
  }

  if (compact) {
    return (
      <Paper component="details" variant="outlined" aria-label="研究细节" sx={{ mt: 1.5, bgcolor: 'action.selected' }}>
        <Box component="summary" sx={{ display: 'flex', cursor: 'pointer', listStyle: 'none', alignItems: 'center', justifyContent: 'space-between', gap: 1, px: 1.5, py: 1.5, typography: 'metadata', '&::-webkit-details-marker': { display: 'none' } }}>
          <Box component="span" sx={{ display: 'inline-flex', alignItems: 'center', gap: 1, fontWeight: 500, color: 'text.primary' }}>
            <Radar size={14} color="var(--dr-color-primary)" />
            研究细节
          </Box>
          <Typography component="span" variant="metadata" sx={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', color: 'text.secondary' }}>{round} · {state}</Typography>
        </Box>
        <Box sx={{ borderTop: 1, borderColor: 'divider', px: 1.5, pb: 1.5, pt: 1 }}>
          <Box sx={{ display: 'grid', gridTemplateColumns: { xs: 'repeat(2, minmax(0, 1fr))', sm: 'repeat(4, minmax(0, 1fr))' }, gap: 1 }} aria-label="深度调研统计">
            <ResearchMetric label="已完成方向" value={cumulativeCompleted} emphasized />
            <ResearchMetric label="已打开页面" value={visited ?? '—'} />
            <ResearchMetric label="可引用证据" value={captured} emphasized />
            <ResearchMetric label="检索线索" value={discovered} />
          </Box>
          {discovered > 0 ? (
            <Typography component="p" variant="metadata" sx={{ mt: 1, lineHeight: 1.6, color: captured < discovered ? 'warning.main' : 'text.secondary' }}>
              可引用证据：{captured}/{discovered} 条检索线索已有可核对正文
              {captured < discovered ? '；其余仍只是线索。' : '。'}
            </Typography>
          ) : null}
          <Box sx={{ mt: 1, border: 1, borderColor: 'divider', borderRadius: 1, bgcolor: 'background.default', px: 1.5, py: 1, typography: 'metadata', lineHeight: 1.6 }}>
            <Box component="span" sx={{ fontWeight: 500, color: 'text.primary' }}>当前研究方向：</Box>
            <Box component="span" sx={{ color: 'text.secondary' }}>{terminal
              ? terminalStatus === 'partial'
                ? '任务在生成报告前停止；已保留本轮实际抓取的正文'
              : terminalStatus === 'succeeded'
                  ? publicationNeedsReview
                    ? '检索与写作已完成，关键结论还需要确认'
                    : collectionTimeboxed
                    ? '检索达到时间盒，已基于现有证据完成综合'
                    : '本轮研究已收敛'
                  : '本轮研究已结束'
              : focus || (adaptive?.stoppedEarly && stopReasonLabel) || '正在拆分并行研究方向'}</Box>
          </Box>
          <Box sx={{ mt: 1, display: 'flex', flexWrap: 'wrap', alignItems: 'center', columnGap: 1.5, rowGap: 0.5, typography: 'metadata', lineHeight: 1.6, color: 'text.secondary' }}>
            {currentRoundTotal > 0 ? <span>本轮 {currentRoundCompleted}/{currentRoundTotal} 个方向</span> : null}
            {coverage.length > 0 ? <span>官方资料已覆盖 {coveredProducts}/{coverage.length} 个产品</span> : null}
            {followupLabel ? <span>{followupLabel}</span> : null}
            {evidenceGapLabel ? <Box component="span" sx={{ color: 'warning.main' }}>{evidenceGapLabel}</Box> : null}
          </Box>
          {collectionTimeboxed ? (
            <Typography component="p" variant="metadata" sx={{ mt: 1, lineHeight: 1.6, color: 'warning.main' }}>
              检索已达到本轮时间盒{progress.collectionTimeboxSeconds ? `（${progress.collectionTimeboxSeconds} 秒）` : ''}；已停止继续扩展研究树，正在基于现有证据生成报告。
            </Typography>
          ) : null}
          {retrievalDegraded ? (
            <Box sx={{ mt: 1, display: 'flex', alignItems: 'flex-start', gap: 1, typography: 'metadata', lineHeight: 1.6, color: 'warning.main' }} title="部分搜索轮次没有返回结果；这些轮次不会被当作证据">
              <Box component="span" sx={{ mt: 0.5, display: 'inline-flex', flexShrink: 0 }}><AlertTriangle size={12} aria-hidden /></Box>
              <Box component="span">
                {retrievalLabel} {captured > 0 ? `当前仍可核对 ${captured} 条正文。` : ''}
              </Box>
            </Box>
          ) : null}
        </Box>
      </Paper>
    );
  }

  return (
    <Paper component="section" variant="outlined" aria-label="深度调研进度" sx={{ mt: compact ? 0 : 2, px: compact ? 1.5 : 2, py: compact ? 1.25 : 1.5, bgcolor: 'action.selected', borderColor: 'primary.main' }}>
      <Box sx={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', columnGap: 1.5, rowGap: 1, typography: 'metadata' }} aria-live="polite">
        <Box component="span" sx={{ display: 'inline-flex', alignItems: 'center', gap: 1, fontWeight: 500, color: 'text.primary' }}>
          <Radar size={14} color="var(--dr-color-primary)" />
          深度调研
        </Box>
        <Box component="span" sx={{ color: 'primary.main' }}>{round}</Box>
        <Box component="span" sx={{ color: 'text.secondary' }}>{branchLabel}</Box>
        <Box component="span" sx={{ color: 'text.secondary' }}>· {state}</Box>
      </Box>
      <Typography component="p" variant="metadata" sx={{ mt: 0.5, lineHeight: 1.6, color: 'text.secondary' }}>
        先按产品和证据主题分别覆盖多个角度；只有证据不足或出现新缺口时才会继续追查，证据够了就收敛。
      </Typography>
      {followupLabel ? (
        <Typography component="p" variant="metadata" sx={{ mt: 1, lineHeight: 1.6, color: 'text.secondary' }}>
          研究树：{followupLabel}。补查只针对尚未解决的证据缺口，不会把重复搜索计入有效证据。
        </Typography>
      ) : null}
      <Box sx={{ mt: 1, display: 'grid', gridTemplateColumns: { xs: 'repeat(2, minmax(0, 1fr))', sm: 'repeat(4, minmax(0, 1fr))' }, gap: 1, typography: 'metadata' }} aria-label="研究覆盖统计">
        <ResearchMetric label="已完成方向" value={cumulativeCompleted} emphasized />
        <ResearchMetric label="已打开页面" value={visited ?? '—'} />
        <ResearchMetric label="检索线索" value={discovered} />
        <ResearchMetric label="可引用证据" value={captured} emphasized />
      </Box>
      <Typography component="p" variant="metadata" sx={{ mt: 1, lineHeight: 1.6, color: 'text.secondary' }}>
        检索线索只是研究树中的候选页面；可引用证据表示已打开并取得可核对正文。没有记录页面数时不做推算；数字本身不能单独证明结论正确。
      </Typography>
      {discovered > 0 ? (
        <Typography component="p" variant="metadata" sx={{ mt: 1, lineHeight: 1.6, color: captured < discovered ? 'warning.main' : 'text.secondary' }}>
          可引用证据：{captured}/{discovered} 条检索线索已有可核对正文
          {captured < discovered ? '；其余仍只是线索。' : '。'}
        </Typography>
      ) : null}
      {selectedProvider ? (
        <Typography component="p" variant="metadata" sx={{ mt: 1, lineHeight: 1.6, color: 'text.secondary' }}>
          已启用联网检索；相同问题会复用结果，服务波动时自动切换备用检索。
        </Typography>
      ) : null}
      {retrievalDegraded ? (
        <Box component="p" sx={{ mt: 1, display: 'flex', alignItems: 'flex-start', gap: 1, typography: 'metadata', lineHeight: 1.6, color: 'warning.main' }} title="部分搜索轮次没有返回结果；这些轮次不会被当作证据">
          <Box component="span" sx={{ mt: 0.5, display: 'inline-flex', flexShrink: 0 }}><AlertTriangle size={12} aria-hidden /></Box>
          <Box component="span">{retrievalLabel} {captured > 0 ? `当前仍可核对 ${captured} 条正文。` : ''}</Box>
        </Box>
      ) : null}
      {focus && !terminal ? (
        <Typography component="p" variant="metadata" sx={{ mt: 1, overflow: 'hidden', display: '-webkit-box', WebkitBoxOrient: 'vertical', WebkitLineClamp: 2, lineHeight: 1.6, color: 'text.secondary' }}>
          当前方向：{focus}
        </Typography>
      ) : null}
      {waitingForEvidence ? (
        <Box sx={{ mt: 1, display: 'flex', alignItems: 'flex-start', gap: 1, border: 1, borderColor: 'divider', borderRadius: 1, bgcolor: 'background.default', px: 1.5, py: 1, typography: 'metadata', lineHeight: 1.6, color: 'text.secondary' }} role="status">
          <CircularProgress size={14} thickness={5} sx={{ mt: 0.5, flexShrink: 0, color: 'primary.main' }} aria-hidden />
          <Typography component="p" variant="metadata">
            {idleSeconds >= 90
              ? `当前资料响应较慢，已等待约 ${Math.floor(idleSeconds / 60)} 分钟；任务仍在后台运行，已抓取的证据会保留。`
              : '当前资料响应较慢；深度检索仍在等待可核对正文，已抓取的证据会持续保留。'}
          </Typography>
        </Box>
      ) : null}
      {coverage.length > 0 ? (
        <Box sx={{ mt: 1, display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 1, typography: 'metadata' }} aria-label="官方资料覆盖">
          <Box component="span" sx={{ color: 'text.secondary' }}>官方资料覆盖</Box>
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
              <Box
                component="span"
                key={item.label}
                sx={{
                  border: 1, borderRadius: 999, px: 1, py: 0.5,
                  ...(item.status === 'covered'
                    ? { borderColor: 'success.main', bgcolor: 'var(--dr-color-success-container)', color: 'success.main' }
                    : item.status === 'pending' || item.status === 'partial'
                      ? { borderColor: 'warning.main', bgcolor: 'var(--dr-color-warning-container)', color: 'warning.main' }
                      : { borderColor: 'divider', bgcolor: 'background.default', color: 'text.secondary' }),
                }}
                title={`${item.label}：${item.discovered} 个独立页面，已抓取 ${item.captured} 条正文；至少需要 ${required} 条`}
              >
                {item.label} · {state}{item.captured > 0 ? ` ${item.status === 'covered' ? `${item.captured} 条` : `${item.captured}/${required}`}` : ''}
              </Box>
            );
          })}
        </Box>
      ) : null}
      {progress.coverageRepair && progress.coverageRepair.attempted > 0 ? (
        <Typography component="p" variant="metadata" sx={{ mt: 1, lineHeight: 1.6, color: 'text.secondary' }}>
          已针对证据不足的产品补查 {progress.coverageRepair.attempted} 个官方入口，新增 {progress.coverageRepair.captured} 条已抓取正文。
        </Typography>
      ) : null}
      {collectionTimeboxed ? (
        <Typography component="p" variant="metadata" sx={{ mt: 1, lineHeight: 1.6, color: 'warning.main' }}>
          检索已达到本轮时间盒{progress.collectionTimeboxSeconds ? `（${progress.collectionTimeboxSeconds} 秒）` : ''}；后续报告只基于已抓取正文，不会把未打开的线索当成证据。
        </Typography>
      ) : null}
      {evidenceGapRepair && evidenceGapRepair.attempted > 0 ? (
        <Typography component="p" variant="metadata" sx={{ mt: 1, lineHeight: 1.6, color: 'text.secondary' }}>
          研究阶段已补查 {evidenceGapRepair.resolved} 个证据缺口；
          {evidenceGapRepair.remaining > 0 ? `仍有 ${evidenceGapRepair.remaining} 个未解决，结果中会提示需要确认。` : '本轮没有遗留研究资料缺口。'}
        </Typography>
      ) : null}
      {reportWriteFallback ? (
        <Typography component="p" variant="metadata" sx={{ mt: 1, lineHeight: 1.6, color: 'warning.main' }}>
          {reportWriteFallback.reason === 'timeout'
            ? `主报告写作超过 ${reportWriteFallback.timeoutSeconds ?? 180} 秒，`
            : reportWriteFallback.reason === 'timeout_or_unavailable'
              ? '主报告写作超时或暂不可用，'
              : '主报告写作未返回有效正文，'}
          已尝试根据本轮实际抓取的证据重写；是否生成研究正文，以最终结果为准。
        </Typography>
      ) : null}
      {retrievalDegraded ? (
        <Box sx={{ mt: 1, display: 'flex', alignItems: 'flex-start', gap: 1, border: 1, borderColor: 'warning.main', borderRadius: 1, bgcolor: 'var(--dr-color-warning-container)', px: 1.5, py: 1, typography: 'metadata', lineHeight: 1.6, color: 'warning.main' }} role="status">
          <Box component="span" sx={{ mt: 0.5, display: 'inline-flex', flexShrink: 0 }}><AlertTriangle size={14} aria-hidden /></Box>
          <Typography component="p" variant="metadata">
            {retrievalLabel} 当前仍可核对 {captured} 条正文。
          </Typography>
        </Box>
      ) : null}
    </Paper>
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
    <Paper variant="outlined" sx={{ px: 1, py: 1, bgcolor: 'background.paper' }}>
      <Typography variant="metadata" sx={{ fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', fontWeight: 600, fontVariantNumeric: 'tabular-nums', color: emphasized ? 'primary.main' : 'text.primary' }}>{value}</Typography>
      <Typography variant="metadata" component="div" color={emphasized ? 'primary.main' : 'text.secondary'} sx={{ mt: 0.5 }}>{label}</Typography>
    </Paper>
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
    <Paper variant="outlined" sx={{ minWidth: 0, px: 1.5, py: 1, bgcolor: 'background.paper' }}>
      <Typography variant="body2" component="div" sx={{ overflow: 'hidden', textOverflow: 'ellipsis', fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', fontWeight: 600, fontVariantNumeric: 'tabular-nums', color: emphasized ? 'primary.main' : 'text.primary' }}>
        {value}
      </Typography>
      <Typography variant="metadata" component="div" color="text.secondary" sx={{ mt: 0.5, overflow: 'hidden', textOverflow: 'ellipsis' }}>{label}</Typography>
    </Paper>
  );
}
