'use client';

import { useQuery, useQueryClient } from '@tanstack/react-query';
import React, { useEffect } from 'react';
import { AlertTriangle, Check, CheckCircle2, Clock3, ExternalLink } from 'lucide-react';
import NextLink from 'next/link';

import { ArtifactPreview } from '@/components/ai-research/ArtifactPreview';
import { ResearchWebBrief } from '@/components/ai-research/ResearchWebBrief';
import { MarkdownPreview } from '@/components/MarkdownPreview';
import Box from '@mui/material/Box';
import Link from '@mui/material/Link';
import LinearProgress from '@mui/material/LinearProgress';
import Paper from '@mui/material/Paper';
import { StatusBadge } from '@/components/domain/StatusBadge';
import { AiResearchButton as Button } from '@/components/ai-research/AiResearchMaterial';
import Skeleton from '@mui/material/Skeleton';
import Typography from '@mui/material/Typography';
import { ApiHttpError, toApiHttpError } from '@/lib/errors/api-error';
import { retryOnceAi, friendlyMessage } from '@/lib/errors/friendly';
import { progressPct } from '@/lib/ai-progress';
import { researchUserStatus } from '@/lib/research-user-status';
import { capturedResearchSourceCount } from '@/lib/research-evidence-profile';
import { DeepResearchProgressCard } from '@/components/ai-research/DeepResearchProgressCard';
import type { DeepResearchProgress } from '@/lib/ai-progress';

interface InlineJob {
  jobId: string;
  topic: string | null;
  status: string;
  finalStatus: string | null;
  currentStep: string | null;
  sourcesCount: number;
  partialSourcesCount: number;
  capturedSourcesCount?: number;
  failedSourcesCount: number;
  savedSourcesCount?: number;
  draftResearchId: string | null;
  reportType: string | null;
  reportLength?: 'brief' | 'standard' | 'deep';
  deliverableStatus?: 'report' | 'evidence_only' | 'none';
  researchProgress?: DeepResearchProgress | null;
  outputText: string | null;
  errorCode: string | null;
  errorMessage: string | null;
  artifact: {
    type: 'markdown' | 'slides' | 'table' | 'chart';
    title: string;
    content: string | null;
  } | null;
  sources: Array<{
    id: string;
    title: string;
    snippet?: string | null;
    score?: number | null;
    href?: string | null;
    type?: string;
    stepCaptured?: string | null;
    capturedAt?: string;
  }>;
  review?: { status?: string | null; phase?: string | null; error?: string | null; error_code?: string | null } | null;
  reviewRun?: { executionStatus?: string | null } | null;
}

const TERMINAL = new Set(['succeeded', 'failed', 'cancelled', 'partial']);
const REVIEW_IN_PROGRESS = new Set(['queued', 'reviewing']);
const STEP_ORDER = ['plan', 'search', 'compress', 'analyze', 'write'] as const;
const STEP_LABELS: Record<string, string> = {
  plan: '规划问题',
  search: '检索资料',
  compress: '整理证据',
  analyze: '分析对比',
  write: '生成产物',
};

export function shouldPollInlineResearch(job: Pick<InlineJob, 'status' | 'finalStatus' | 'review' | 'reviewRun'> | undefined): boolean {
  if (!job) return true;
  const status = job.finalStatus ?? job.status;
  const reviewStatus = job.reviewRun?.executionStatus ?? job.review?.status ?? job.review?.phase;
  return !status || !TERMINAL.has(status) || REVIEW_IN_PROGRESS.has(reviewStatus ?? '');
}

/** 横向阶段 stepper：plan → search → compress → analyze → write。 */
function StepStepper({ currentStep, succeeded }: { currentStep: string | null; succeeded: boolean }) {
  const activeIndex = currentStep ? STEP_ORDER.indexOf(currentStep as (typeof STEP_ORDER)[number]) : -1;
  return (
    <Box component="ol" sx={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 1, m: 0, p: 0, listStyle: 'none' }} aria-label="调研步骤">
      {STEP_ORDER.map((key, index) => {
        const state = succeeded || (activeIndex >= 0 && index < activeIndex) ? 'done' : index === activeIndex ? 'active' : 'todo';
        return (
          <Box component="li" key={key} sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
            {index > 0 ? <Box component="span" sx={{ mx: 0.5, width: 12, height: '1px', bgcolor: 'divider' }} aria-hidden /> : null}
            <Box
              component="span"
              sx={{
                display: 'flex', width: 20, height: 20, alignItems: 'center', justifyContent: 'center', borderRadius: '50%',
                typography: 'metadata', fontWeight: 500, lineHeight: 1,
                ...(state === 'done'
                  ? { bgcolor: 'var(--dr-color-success-container)', color: 'success.main' }
                  : state === 'active'
                    ? { bgcolor: 'primary.main', color: 'primary.contrastText' }
                    : { bgcolor: 'action.hover', color: 'text.disabled' }),
              }}
            >
              {state === 'done' ? <Check size={12} /> : index + 1}
            </Box>
            <Typography component="span" variant="metadata" sx={{ fontWeight: state === 'active' ? 500 : undefined, color: state === 'active' ? 'text.primary' : state === 'done' ? 'text.secondary' : 'text.disabled' }}>
              {STEP_LABELS[key]}
            </Typography>
          </Box>
        );
      })}
    </Box>
  );
}

export function InlineAiResearchStatus({ jobId }: { jobId: string }) {
  const queryClient = useQueryClient();
  const query = useQuery<InlineJob>({
    queryKey: ['inline-ai-research', jobId],
    queryFn: async () => {
      const response = await fetch(`/api/ai-research/${jobId}`, { cache: 'no-store' });
      if (!response.ok) throw await toApiHttpError(response, '读取调研状态失败');
      return (await response.json()) as InlineJob;
    },
    retry: retryOnceAi,
    refetchInterval: (data) => shouldPollInlineResearch(data.state.data) ? 5_000 : false,
  });

  const liveStatus = query.data?.finalStatus ?? query.data?.status;
  const liveTerminal = !!liveStatus && TERMINAL.has(liveStatus) && !shouldPollInlineResearch(query.data);

  useEffect(() => {
    if (liveTerminal) return;
    const controller = new AbortController();
    let cancelled = false;

    async function consumeProgress() {
      try {
        const response = await fetch(`/api/ai-research/${jobId}/stream`, {
          cache: 'no-store',
          signal: controller.signal,
        });
        if (!response.ok || !response.body) return;

        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';
        while (!cancelled) {
          const { value, done } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          const frames = buffer.split('\n\n');
          buffer = frames.pop() ?? '';
          for (const frame of frames) {
            const dataLine = frame.split('\n').find((line) => line.startsWith('data: '));
            if (!dataLine) continue;
            const payload = JSON.parse(dataLine.slice(6)) as Partial<InlineJob> & { finalStatus?: string | null };
            if (payload.status === 'failed' || payload.finalStatus === 'failed') {
              queryClient.invalidateQueries({ queryKey: ['inline-ai-research', jobId] });
            }
            queryClient.setQueryData<InlineJob>(['inline-ai-research', jobId], (old) => {
              if (!old) return old;
              return { ...old, ...payload };
            });
          }
        }
      } catch {
        // Polling remains active as the durable fallback when SSE is unavailable.
      }
    }

    void consumeProgress();
    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [jobId, liveTerminal, queryClient]);

  if (query.isLoading) {
    return (
      <Paper component="section" variant="outlined" aria-label="调研状态" sx={{ p: 2 }}>
        <Skeleton variant="text" width={128} height={20} />
        <Skeleton variant="rounded" sx={{ mt: 1.5, height: 8, width: '100%' }} />
        <Skeleton variant="rounded" sx={{ mt: 2, height: 48, width: '100%' }} />
      </Paper>
    );
  }

  if (!query.data || (query.isError && query.error instanceof ApiHttpError && [401, 403, 404].includes(query.error.status))) {
    return (
      <Paper component="section" variant="outlined" role="alert" sx={{ p: 2, borderColor: 'error.main', bgcolor: 'var(--dr-color-danger-container)' }}>
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, typography: 'body2', fontWeight: 500, color: 'error.main' }}>
          <AlertTriangle size={16} />
          调研状态暂时不可读
        </Box>
        <Typography component="p" variant="metadata" sx={{ mt: 0.5, color: 'text.secondary' }}>{friendlyMessage(query.error, '请稍后重试。')}</Typography>
      </Paper>
    );
  }

  const job = query.data;
  const status = job.finalStatus ?? job.status;
  const terminal = TERMINAL.has(status);
  const pct = progressPct({
    status: job.status,
    finalStatus: job.finalStatus,
    currentStep: job.currentStep,
    researchProgress: job.researchProgress,
  });
  // Deep runs expose captured evidence through the live progress payload
  // before the durable source count catches up. Never fall back to
  // sourcesCount here: that is a discovered-page count, not proof that a
  // body was fetched and can be inspected.
  const evidenceCount = capturedResearchSourceCount(job);
  const isBrief = job.reportType === 'summary_brief';
  const evidenceOnly = job.deliverableStatus === 'evidence_only';
  const userStatus = researchUserStatus({
    status,
    reportType: job.reportType,
    hasReport: Boolean(job.artifact?.content || job.outputText),
    reviewStatus: job.review?.status,
    deliverableStatus: job.deliverableStatus,
    capturedSourcesCount: evidenceCount,
  });
  const reviewUnavailable = userStatus.code === 'review_unavailable';
  const deliverableLabel = evidenceOnly
    ? '资料摘要'
    : status === 'partial'
      ? '阶段性研究稿'
      : job.reportType === 'slides'
        ? 'Slides 提纲'
        : job.reportType === 'web_brief'
          ? '网页简报'
        : job.reportType === 'summary_brief'
          ? '快速判断'
          : '研究稿';

  return (
    <Paper component="section" variant="outlined" aria-label="调研状态" sx={{ overflow: 'hidden' }}>
      <Box component="header" sx={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', justifyContent: 'space-between', gap: 1.5, borderBottom: 1, borderColor: 'divider', px: 2, py: 1.5 }}>
        <Box sx={{ minWidth: 0 }}>
          <Box sx={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 1 }}>
            {userStatus.code === 'failed' || userStatus.code === 'needs_revision'
              ? <AlertTriangle size={16} color="var(--dr-color-warning)" />
              : userStatus.code === 'ready'
                ? <CheckCircle2 size={16} color="var(--dr-color-success)" />
                : terminal
                  ? <AlertTriangle size={16} color="var(--dr-color-warning)" />
                  : <Clock3 size={16} color="var(--dr-color-primary)" />}
            <Typography component="span" variant="body2" sx={{ fontWeight: 600 }}>
              {terminal ? userStatus.label : '正在研究'}
            </Typography>
            <StatusBadge kind="job" value={userStatus.code === 'ready' ? 'succeeded' : userStatus.code === 'failed' ? 'failed' : 'partial'} label={userStatus.label} />
          </Box>
          <Typography component="p" variant="metadata" noWrap sx={{ mt: 0.5, color: 'text.secondary' }}>{job.topic ?? '当前调研'}</Typography>
        </Box>
        <Link component={NextLink} href={`/ai-research/${job.jobId}`} underline="hover" sx={{ display: 'inline-flex', alignItems: 'center', gap: 0.5, typography: 'metadata', fontWeight: 500, color: 'primary.main' }}>
          打开完整任务
          <ExternalLink size={12} />
        </Link>
      </Box>

      <Box sx={{ display: 'grid', gap: 2, p: 2 }}>
        {query.isError ? (
          <Typography role="status" variant="metadata" color="warning.main">
            进度更新暂时中断，正在重试；以下保留最近一次状态。
          </Typography>
        ) : null}
        {!isBrief ? <StepStepper currentStep={job.currentStep} succeeded={terminal && status === 'succeeded'} /> : null}
        {isBrief ? <Typography variant="metadata" color="text.secondary">快速判断不做完整检索或逐条核验；{evidenceCount > 0 ? `已参考 ${evidenceCount} 条可核对资料。` : '仅模型摘录，未保存可核对资料。'}</Typography> : null}

        {reviewUnavailable ? (
          <Box sx={{ border: 1, borderColor: 'warning.main', borderRadius: 1, bgcolor: 'var(--dr-color-warning-container)', px: 1.5, py: 1, typography: 'metadata', lineHeight: 1.6, color: 'warning.main' }} role="status">
            <Box component="strong" sx={{ fontWeight: 500 }}>{userStatus.description}</Box>
            <Box component="span" sx={{ ml: 1 }}>可以打开完整任务查看依据，或稍后重新检查。</Box>
          </Box>
        ) : null}

        <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, typography: 'metadata', color: 'text.secondary' }}>
          <LinearProgress variant="determinate" value={pct} sx={{ width: { xs: 128, sm: 192 }, height: 6, borderRadius: 'var(--dr-radius-pill)' }} />
          <Typography component="span" variant="metadata" sx={{ fontFamily: 'monospace', fontVariantNumeric: 'tabular-nums' }}>{pct}%</Typography>
        </Box>

        <Box sx={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 1 }}>
          <Box component="span" sx={{ display: 'inline-flex', alignItems: 'center', border: 1, borderColor: 'divider', borderRadius: 999, bgcolor: 'background.paper', px: 1, py: 0.5, typography: 'metadata', color: 'text.secondary' }}>
            {isBrief ? '可核对资料' : '已抓取正文'} <Box component="span" sx={{ ml: 0.5, fontFamily: 'monospace', fontVariantNumeric: 'tabular-nums', color: 'text.primary' }}>{evidenceCount}</Box>
          </Box>
          {terminal && status === 'partial' && job.partialSourcesCount > 0 ? (
            <Box component="span" sx={{ display: 'inline-flex', alignItems: 'center', border: 1, borderColor: 'warning.main', borderRadius: 999, bgcolor: 'var(--dr-color-warning-container)', px: 1, py: 0.5, typography: 'metadata', color: 'warning.main' }}>
              部分 <Box component="span" sx={{ ml: 0.5, fontFamily: 'monospace', fontVariantNumeric: 'tabular-nums' }}>{job.partialSourcesCount}</Box>
            </Box>
          ) : null}
          {job.failedSourcesCount > 0 ? (
            <Box component="span" sx={{ display: 'inline-flex', alignItems: 'center', border: 1, borderColor: 'error.main', borderRadius: 999, bgcolor: 'var(--dr-color-danger-container)', px: 1, py: 0.5, typography: 'metadata', color: 'error.main' }}>
              失败 <Box component="span" sx={{ ml: 0.5, fontFamily: 'monospace', fontVariantNumeric: 'tabular-nums' }}>{job.failedSourcesCount}</Box>
            </Box>
          ) : null}
          <Box component="span" sx={{ display: 'inline-flex', alignItems: 'center', border: 1, borderColor: 'divider', borderRadius: 999, bgcolor: 'background.paper', px: 1, py: 0.5, typography: 'metadata', color: 'text.secondary' }}>
            {deliverableLabel}
          </Box>
        </Box>

        {job.reportLength === 'deep' && job.researchProgress?.mode === 'deep' ? (
          <DeepResearchProgressCard
            progress={job.researchProgress}
            savedSources={job.savedSourcesCount ?? job.sourcesCount}
            capturedSources={evidenceCount}
            terminalStatus={status}
            compact
          />
        ) : null}

        {status === 'failed' || status === 'partial' ? (
          <Box sx={{ border: 1, borderRadius: 1, p: 1.5, typography: 'body2', ...(status === 'partial' ? { borderColor: 'warning.main', bgcolor: 'var(--dr-color-warning-container)', color: 'warning.main' } : { borderColor: 'error.main', bgcolor: 'var(--dr-color-danger-container)', color: 'error.main' }) }} role="alert">
            <Box component="strong" sx={{ fontWeight: 500 }}>
              {evidenceOnly
                ? '资料已保留，但没有形成可交付结论'
                : status === 'partial' ? '本次调研提前停止' : '调研失败'}
            </Box>
            <Box component="span" sx={{ ml: 1 }}>
              {job.errorCode ? friendlyMessage({ code: job.errorCode }, '调研未能继续') : '请打开完整任务查看详情。'}
            </Box>
            {job.errorMessage ? <Typography component="p" variant="metadata" sx={{ mt: 1, opacity: 0.9 }}>{job.errorMessage}</Typography> : null}
            {status === 'partial' ? (
              <Typography component="p" variant="metadata" sx={{ mt: 1, opacity: 0.8 }}>
                {evidenceOnly
                  ? '已抓取的正文仍可在完整任务中核对；重新运行会重新生成研究稿，不会把这次资料摘要当成结论。'
                  : '已抓取的正文仍可核对；重新运行会创建一条新的调研任务。'}
              </Typography>
            ) : null}
          </Box>
        ) : null}

        {status === 'succeeded' && job.artifact?.content ? (
          <Box sx={{ borderTop: 1, borderColor: 'divider', pt: 2 }}>
            {job.artifact.type === 'slides' ? (
              <ArtifactPreview content={job.artifact.content} />
            ) : job.reportType === 'web_brief' ? (
              <ResearchWebBrief
                content={job.artifact.content}
                sources={job.sources}
                reviewStatus={job.review?.status}
              />
            ) : (
              <MarkdownPreview
                source={job.artifact.content}
                sx={{
                  maxHeight: 'none',
                  overflow: 'visible',
                  bgcolor: 'background.paper',
                  '@media (min-width: 1024px)': { maxHeight: 720, overflowY: 'auto' },
                }}
              />
            )}
          </Box>
        ) : status === 'succeeded' && job.outputText ? (
          <MarkdownPreview
            source={job.outputText}
            sx={{
              maxHeight: 'none',
              overflow: 'visible',
              bgcolor: 'background.paper',
              '@media (min-width: 1024px)': { maxHeight: 720, overflowY: 'auto' },
            }}
          />
        ) : null}

        {status === 'succeeded' && job.draftResearchId ? (
          <Button asChild size="sm" variant="outline">
            <NextLink href={`/researches/${job.draftResearchId}`}>打开可编辑草稿</NextLink>
          </Button>
        ) : null}
      </Box>
    </Paper>
  );
}
