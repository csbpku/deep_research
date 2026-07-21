'use client';

import { useQuery } from '@tanstack/react-query';
import Link from 'next/link';
import { EmptyState } from '../../../components/EmptyState.js';

interface AiJobStatus {
  jobId: string;
  status: string;
  finalStatus: string | null;
  currentStep: string | null;
  sourcesCount: number;
  tokenInputTotal: number;
  tokenOutputTotal: number;
  costCents: number;
  errorCode: string | null;
  errorMessage: string | null;
}

const TERMINAL = new Set(['succeeded', 'failed', 'cancelled', 'partial']);

/**
 * AI 调研任务状态页。
 *
 * 验收 4：每 5s 轮询 /api/ai-research/[jobId]；终态自动停止。
 *
 * 当前 ai-engine（Week 1）同步执行 fake adapter；多数情况下首次轮询即拿到终态。
 * 本前端代码在 Week 5 ai-engine 接入 DB + 队列后无需改动。
 */
export default function AiJobStatusPage({ params }: { params: { jobId: string } }) {
  const q = useQuery<AiJobStatus>({
    queryKey: ['ai-job', params.jobId],
    queryFn: async () => {
      const r = await fetch(`/api/ai-research/${params.jobId}`, { cache: 'no-store' });
      if (!r.ok) {
        const err = await r.json().catch(() => ({ message: '加载失败' }));
        throw new Error(err.message ?? '加载失败');
      }
      return (await r.json()) as AiJobStatus;
    },
    refetchInterval: (data) => {
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
    <div>
      <Link href="/ai-research" style={{ fontSize: 13, color: '#475569' }}>
        ← 返回 AI 调研
      </Link>

      <h1 style={{ fontSize: 22, margin: '12px 0 4px' }}>AI 调研任务</h1>
      <p style={{ color: '#475569', marginTop: 0, fontFamily: 'monospace', fontSize: 13 }}>
        job id: {params.jobId}
      </p>

      {q.isLoading ? (
        <p style={{ color: '#475569' }}>加载中…</p>
      ) : q.isError ? (
        <EmptyState title="加载失败" description={String((q.error as Error).message)} />
      ) : q.data ? (
        <StatusBody s={q.data} />
      ) : null}
    </div>
  );
}

function StatusBody({ s }: { s: AiJobStatus }) {
  const finalStatus = s.finalStatus;
  const isTerminal = finalStatus && TERMINAL.has(finalStatus);
  return (
    <div style={{ marginTop: 12 }}>
      <div style={{ display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap' }}>
        <StatusBadge status={s.status} finalStatus={s.finalStatus} />
        {s.currentStep ? <StepBadge step={s.currentStep} /> : null}
        <span style={{ marginLeft: 'auto', color: '#475569', fontSize: 13 }}>
          来源 {s.sourcesCount} · token in/out {s.tokenInputTotal}/{s.tokenOutputTotal} · 成本 {s.costCents}¢
        </span>
      </div>

      {s.errorCode ? (
        <div
          role="alert"
          style={{
            marginTop: 12,
            padding: 12,
            border: '1px solid #fecaca',
            background: '#fef2f2',
            borderRadius: 6,
            color: '#991b1b',
            fontSize: 13,
          }}
        >
          <strong>{s.errorCode}</strong>: {s.errorMessage ?? '未知错误'}
        </div>
      ) : null}

      {!isTerminal ? (
        <p style={{ color: '#475569', marginTop: 12, fontSize: 13 }}>
          每 5 秒自动刷新；任务进入终态（succeeded / failed / cancelled / partial）后停止。
        </p>
      ) : finalStatus === 'succeeded' ? (
        <p style={{ marginTop: 12, color: '#15803d' }}>
          调研完成。W3+ 启用「打开私有草稿」入口（W2 仅显示状态，不创建草稿）。
        </p>
      ) : finalStatus === 'partial' ? (
        <p style={{ marginTop: 12, color: '#b45309' }}>
          部分成功（≥3 sources 但流水线某步失败）。未创建草稿。
        </p>
      ) : finalStatus === 'failed' ? (
        <p style={{ marginTop: 12, color: '#b91c1c' }}>任务失败。可以回到提交页重新发起。</p>
      ) : finalStatus === 'cancelled' ? (
        <p style={{ marginTop: 12, color: '#475569' }}>已撤回。</p>
      ) : null}
    </div>
  );
}

function StatusBadge({ status, finalStatus }: { status: string; finalStatus: string | null }) {
  const label = finalStatus ?? status;
  const palette: Record<string, { bg: string; fg: string; border: string }> = {
    queued: { bg: '#fef3c7', fg: '#92400e', border: '#fde68a' },
    running: { bg: '#dbeafe', fg: '#1e40af', border: '#bfdbfe' },
    succeeded: { bg: '#dcfce7', fg: '#166534', border: '#bbf7d0' },
    partial: { bg: '#fef3c7', fg: '#92400e', border: '#fde68a' },
    failed: { bg: '#fee2e2', fg: '#991b1b', border: '#fecaca' },
    cancelled: { bg: '#f1f5f9', fg: '#475569', border: '#e2e8f0' },
  };
  const c = palette[label] ?? palette.queued;
  return (
    <span
      style={{
        padding: '4px 10px',
        borderRadius: 12,
        background: c.bg,
        color: c.fg,
        border: `1px solid ${c.border}`,
        fontSize: 12,
        fontWeight: 600,
        textTransform: 'uppercase',
        letterSpacing: 0.5,
      }}
    >
      {label}
    </span>
  );
}

function StepBadge({ step }: { step: string }) {
  const order = ['plan', 'search', 'compress', 'analyze', 'write'];
  const idx = order.indexOf(step);
  return (
    <span
      style={{
        padding: '4px 10px',
        borderRadius: 12,
        background: '#f1f5f9',
        color: '#334155',
        border: '1px solid #e2e8f0',
        fontSize: 12,
        fontFamily: 'monospace',
      }}
      title={`流水线步骤 0-${idx} 已完成，当前在 ${step}`}
    >
      step: {step} ({idx + 1}/{order.length})
    </span>
  );
}
