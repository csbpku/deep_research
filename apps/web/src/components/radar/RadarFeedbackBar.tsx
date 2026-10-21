// RadarFeedbackBar —— 雷达候选卡 / 详情页共用的反馈按钮。
//
// 行为：
//   - 点击 POST /api/radar-feedback → 幂等；服务端约束保证
//   - 再点同一类型 → DELETE 撤回
//   - 当前用户已选类型高亮（按钮加 active 样式）
//   - 显示总数 + 当前用户已选状态
//
// ⚠️ e2e 契约：role="group" aria-label="雷达候选反馈"

'use client';

import React, { useState } from 'react';
import Box from '@mui/material/Box';
import Typography from '@mui/material/Typography';
import { space } from '@deep-research/design-system';
import {
  CheckCircle2,
  Search,
  Star,
  ThumbsUp,
  ThumbsDown,
  type LucideIcon,
} from 'lucide-react';

import { AppButton as Button } from '@/components/material/AppButton';

export type RadarFeedbackType =
  | 'useful'
  | 'inaccurate'
  | 'used'
  | 'favorite'
  | 'suggest_research';

export type RadarFeedbackCounts = Record<RadarFeedbackType, number>;

interface RadarFeedbackBarProps {
  summaryId: string;
  initialCounts: RadarFeedbackCounts;
  initialMine: RadarFeedbackType[];
  /** 列表页只需要收藏；详情页保留完整的公共反馈集合。 */
  types?: readonly RadarFeedbackType[];
  className?: string;
}

const FEEDBACK_LABELS: Record<RadarFeedbackType, { label: string; icon: LucideIcon }> = {
  useful: { label: '点赞', icon: ThumbsUp },
  inaccurate: { label: '点踩', icon: ThumbsDown },
  used: { label: '我用过', icon: CheckCircle2 },
  favorite: { label: '收藏', icon: Star },
  suggest_research: { label: '建议调研', icon: Search },
};

const ALL_TYPES: RadarFeedbackType[] = [
  'favorite',
  'inaccurate',
];

export function RadarFeedbackBar({
  summaryId,
  initialCounts,
  initialMine,
  types = ALL_TYPES,
  className,
}: RadarFeedbackBarProps) {
  const [counts, setCounts] = useState<RadarFeedbackCounts>(initialCounts);
  const [mine, setMine] = useState<RadarFeedbackType[]>(initialMine);
  const [pending, setPending] = useState<RadarFeedbackType | null>(null);
  const [err, setErr] = useState<string | null>(null);

  async function callFeedback(ft: RadarFeedbackType, isOn: boolean, action: 'toggle-on' | 'toggle-off') {
    setPending(ft);
    setErr(null);
    try {
      if (action === 'toggle-off') {
        const r = await fetch(
          `/api/radar-feedback?summaryId=${encodeURIComponent(summaryId)}&feedbackType=${encodeURIComponent(ft)}`,
          { method: 'DELETE' },
        );
        if (!r.ok) {
          const body = (await r.json().catch(() => ({}))) as { message?: string };
          throw new Error(body.message ?? '撤回失败');
        }
        const body = (await r.json()) as { feedbackCounts: RadarFeedbackCounts };
        setCounts(body.feedbackCounts);
        setMine((prev) => prev.filter((t) => t !== ft));
      } else {
        const r = await fetch('/api/radar-feedback', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ summaryId, feedbackType: ft }),
        });
        if (!r.ok) {
          const body = (await r.json().catch(() => ({}))) as { message?: string };
          throw new Error(body.message ?? '提交失败');
        }
        const body = (await r.json()) as { feedbackCounts: RadarFeedbackCounts };
        setCounts(body.feedbackCounts);
        if (isOn) {
          setMine((prev) => prev.includes(ft) ? prev : [...prev, ft]);
        } else {
          setMine((prev) => prev.filter((t) => t !== ft));
        }
      }
    } catch (e) {
      setErr(e instanceof Error ? e.message : '操作失败');
    } finally {
      setPending(null);
    }
  }

  function handleClick(ft: RadarFeedbackType) {
    const isOn = mine.includes(ft);
    void callFeedback(ft, !isOn, isOn ? 'toggle-off' : 'toggle-on');
  }

  return (
    <Box className={className} role="group" aria-label="雷达候选反馈" sx={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: space.sm, paddingBlock: space.xs }}>
      {types.map((ft) => {
        const meta = FEEDBACK_LABELS[ft];
        const Icon = meta.icon;
        const active = mine.includes(ft);
        const total = counts[ft] ?? 0;
        const isPending = pending === ft;
        return (
          <Button
            key={ft}
            type="button"
            variant={active ? 'contained' : 'outlined'}
            size="small"
            onClick={() => handleClick(ft)}
            disabled={isPending}
            aria-pressed={active}
            aria-label={`${meta.label}（${total}）`}
          >
            <Icon size={16} fill={active ? 'currentColor' : 'none'} aria-hidden />
            {meta.label}
            {ft !== 'favorite' || total > 0 ? (
              <Box component="span" sx={{ fontVariantNumeric: 'tabular-nums' }}>{total}</Box>
            ) : null}
          </Button>
        );
      })}
      {err ? (
        <Typography role="alert" variant="metadata" color="error.main">
          {err}
        </Typography>
      ) : null}
    </Box>
  );
}

export const RADAR_FEEDBACK_TYPES_PUBLIC: readonly RadarFeedbackType[] = ALL_TYPES;
