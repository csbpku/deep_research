import * as React from 'react';

import { cn } from '@/lib/utils';

/**
 * StatusBadge —— 全站唯一的状态徽章。
 *
 * 迁移前，这个东西在 6 个文件里各写了一遍内联样式：
 * RadarCandidateCard / ai-research/page / ai-research/[jobId]/page /
 * researches/[id]/page / AdminConsole / AdminRadarClient。
 *
 * 颜色一律走 globals.css 的领域语义 token，深浅色自动切换。
 * 枚举值与 packages/shared/src/states.ts 严格一致。
 */

type Tone = { className: string; label: string };

/** ai_research_jobs.status / content_import_jobs.status */
const JOB_TONES: Record<string, Tone> = {
  queued: { className: 'bg-status-queued-bg text-status-queued-fg', label: '排队中' },
  running: { className: 'bg-status-running-bg text-status-running-fg', label: '进行中' },
  partial: { className: 'bg-status-partial-bg text-status-partial-fg', label: '部分完成' },
  succeeded: { className: 'bg-status-succeeded-bg text-status-succeeded-fg', label: '已完成' },
  failed: { className: 'bg-status-failed-bg text-status-failed-fg', label: '失败' },
  cancelled: { className: 'bg-status-cancelled-bg text-status-cancelled-fg', label: '已取消' },
};

/** summaries.status（雷达候选生命周期） */
const RADAR_TONES: Record<string, Tone> = {
  candidate: { className: 'bg-radar-candidate-bg text-radar-candidate-fg', label: '候选' },
  pending_review: { className: 'bg-radar-pending-bg text-radar-pending-fg', label: '待审核' },
  published: { className: 'bg-radar-published-bg text-radar-published-fg', label: '已发布' },
  rejected: { className: 'bg-radar-rejected-bg text-radar-rejected-fg', label: '已忽略' },
  archived: { className: 'bg-radar-archived-bg text-radar-archived-fg', label: '已归档' },
};

/** researches.status */
const RESEARCH_TONES: Record<string, Tone> = {
  draft: { className: 'bg-status-queued-bg text-status-queued-fg', label: '草稿' },
  published: { className: 'bg-radar-published-bg text-radar-published-fg', label: '已发布' },
  archived: { className: 'bg-radar-archived-bg text-radar-archived-fg', label: '已归档' },
};

/** researches.creation_method —— 描边样式，与状态徽章视觉上区分开 */
const METHOD_TONES: Record<string, Tone> = {
  manual: { className: 'border border-border text-method-manual', label: '手写' },
  ai_research: { className: 'border border-method-ai/40 text-method-ai', label: 'AI 调研' },
  file_import: { className: 'border border-method-file/40 text-method-file', label: '文件导入' },
  confluence_import: {
    className: 'border border-method-import/40 text-method-import',
    label: 'Confluence',
  },
};

const REGISTRY = {
  job: JOB_TONES,
  radar: RADAR_TONES,
  research: RESEARCH_TONES,
  method: METHOD_TONES,
} as const;

export type StatusKind = keyof typeof REGISTRY;

export interface StatusBadgeProps extends React.HTMLAttributes<HTMLSpanElement> {
  kind: StatusKind;
  value: string;
  /** 覆盖默认中文标签 */
  label?: string;
  /** 前置图标（lucide），可选 */
  icon?: React.ReactNode;
}

export function StatusBadge({
  kind,
  value,
  label,
  icon,
  className,
  ...props
}: StatusBadgeProps) {
  // 未知状态回落到中性色 + 原样展示值，避免静默丢信息。
  const tone = REGISTRY[kind][value] ?? {
    className: 'bg-muted text-muted-foreground',
    label: value,
  };

  return (
    <span
      className={cn(
        'inline-flex items-center gap-1 whitespace-nowrap rounded-full px-2 py-0.5 text-xs font-medium leading-5',
        '[&_svg]:size-3 [&_svg]:shrink-0',
        tone.className,
        className,
      )}
      {...props}
    >
      {icon}
      {label ?? tone.label}
    </span>
  );
}
