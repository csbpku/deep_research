import * as React from 'react';

import Chip from '@mui/material/Chip';
import { domainAppearance, type DomainPalette } from './appearance';
import styles from './domain.module.css';

/**
 * StatusBadge —— 全站唯一的状态徽章。
 *
 * 迁移前，这个东西在 6 个文件里各写了一遍内联样式：
 * RadarCandidateCard / ai-research/page / ai-research/[jobId]/page /
 * researches/[id]/page / AdminConsole / AdminRadarClient。
 *
 * Named domain mappings use shared semantic tokens in both color modes.
 * 枚举值与 packages/shared/src/states.ts 严格一致。
 */

type Tone = { palette: DomainPalette; label: string; outlined?: boolean };

/** ai_research_jobs.status / content_import_jobs.status */
const JOB_TONES: Record<string, Tone> = {
  queued: { palette: 'neutral', label: '排队中' },
  running: { palette: 'evidence', label: '进行中' },
  partial: { palette: 'warning', label: '部分完成' },
  succeeded: { palette: 'success', label: '已完成' },
  failed: { palette: 'danger', label: '失败' },
  cancelled: { palette: 'neutral', label: '已取消' },
};

/** summaries.status（雷达内容生命周期） */
const RADAR_TONES: Record<string, Tone> = {
  candidate: { palette: 'neutral', label: '雷达内容' },
  pending_review: { palette: 'warning', label: '待审核' },
  published: { palette: 'success', label: '历史精选' },
  rejected: { palette: 'danger', label: '已屏蔽' },
  archived: { palette: 'neutral', label: '已归档' },
};

/** researches.status */
const RESEARCH_TONES: Record<string, Tone> = {
  draft: { palette: 'neutral', label: '草稿' },
  published: { palette: 'success', label: '已发布' },
  archived: { palette: 'neutral', label: '已归档' },
};

/** researches.creation_method —— 描边样式，与状态徽章视觉上区分开 */
const METHOD_TONES: Record<string, Tone> = {
  manual: { palette: 'neutral', outlined: true, label: '手写' },
  ai_research: { palette: 'inference', outlined: true, label: 'AI 调研' },
  file_import: { palette: 'context', outlined: true, label: '文件导入' },
  confluence_import: {
    palette: 'evidence', outlined: true,
    label: 'Confluence',
  },
};

/** researches.featuredAt —— 精华徽章，琥珀实心，对应原手写 `border-amber-*` 系列 */
const FEATURED_TONES: Record<string, Tone> = {
  true: { palette: 'warning', outlined: true, label: '精华' },
  false: { palette: 'neutral', label: '' },
};

/** researches.type —— "研究报告 / 知识卡片" 区分 */
const RESEARCH_TYPE_TONES: Record<string, Tone> = {
  research: { palette: 'evidence', label: '研究报告' },
  knowledge: { palette: 'neutral', label: '知识卡片' },
};

/** topic tier —— 主题热度，不与 score tier 共享语义色 */
const TOPIC_TIER_TONES: Record<string, Tone> = {
  hot: { palette: 'danger', label: '热门' },
  warming: { palette: 'warning', label: '升温中' },
  emerging: { palette: 'evidence', label: '新出现' },
};

/** radar issues —— 雷达详情页内的事件/问题徽章 */
const ISSUE_TONES: Record<string, Tone> = {
  info: { palette: 'evidence', outlined: true, label: '信息' },
  warn: { palette: 'warning', outlined: true, label: '提示' },
  error: { palette: 'danger', outlined: true, label: '异常' },
  success: { palette: 'success', outlined: true, label: '已处理' },
};

/** search results type —— 搜索结果类型徽章，使用中性 palette 不与 job status 混淆 */
const SEARCH_TYPE_TONES: Record<string, Tone> = {
  radar: { palette: 'neutral', label: '雷达' },
  summary: { palette: 'neutral', label: '摘要' },
  research: { palette: 'neutral', label: '研究报告' },
  knowledge: { palette: 'neutral', label: '知识卡片' },
  all: { palette: 'neutral', label: '全部' },
};

const REGISTRY = {
  job: JOB_TONES,
  radar: RADAR_TONES,
  research: RESEARCH_TONES,
  method: METHOD_TONES,
  featured: FEATURED_TONES,
  researchType: RESEARCH_TYPE_TONES,
  topicTier: TOPIC_TIER_TONES,
  issue: ISSUE_TONES,
  searchType: SEARCH_TYPE_TONES,
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
  style,
  ...props
}: StatusBadgeProps) {
  // 未知状态回落到中性色 + 原样展示值，避免静默丢信息。
  const registry = REGISTRY[kind];
  const tone = (Object.hasOwn(registry, value) ? registry[value] : undefined) ?? {
    palette: 'neutral' as const,
    label: value,
  };

  // featured=false / 空 label 时不渲染（用于条件显示）
  if (label === '' || (tone.label === '' && !label && !icon)) {
    return null;
  }

  return (
    <span {...props} data-status-kind={kind} data-status-value={value}
      className={[styles.statusBadge, className].filter(Boolean).join(' ')} style={style}>
      <Chip component="span" size="small" variant={tone.outlined ? 'outlined' : 'filled'}
        className={styles.statusChip}
        sx={{ ...domainAppearance(tone.palette), borderColor: tone.outlined ? 'currentColor' : undefined }}
        label={<span className={styles.statusLabel}>{icon}<span>{label ?? tone.label}</span></span>} />
    </span>
  );
}
