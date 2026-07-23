// RadarFeedbackBar —— 雷达候选卡 / 详情页共用的 5 种反馈按钮。
//
// 行为：
//   - 点击 POST /api/radar-feedback → 幂等；服务端约束保证
//   - 再点同一类型 → DELETE 撤回
//   - 当前用户已选类型高亮（按钮加 active 样式）
//   - 显示总数 + 当前用户已选状态

'use client';

import { useState } from 'react';

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
  /** 可选：suggest_research 触发跳转的目标 URL；缺省走 /researches/new */
  suggestResearchHref?: string;
}

const FEEDBACK_LABELS: Record<RadarFeedbackType, { label: string; icon: string }> = {
  useful: { label: '有用', icon: '👍' },
  inaccurate: { label: '不准确', icon: '⚠️' },
  used: { label: '我用过', icon: '✅' },
  favorite: { label: '收藏', icon: '⭐' },
  suggest_research: { label: '建议调研', icon: '🔍' },
};

const ALL_TYPES: RadarFeedbackType[] = [
  'useful',
  'inaccurate',
  'used',
  'favorite',
  'suggest_research',
];

export function RadarFeedbackBar({
  summaryId,
  initialCounts,
  initialMine,
  suggestResearchHref,
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
    // suggest_research 不发 API；只跳链接
    if (ft === 'suggest_research') {
      const href = suggestResearchHref
        ?? `/researches/new?radarSummaryId=${encodeURIComponent(summaryId)}`;
      if (typeof window !== 'undefined') window.location.href = href;
      return;
    }
    const isOn = mine.includes(ft);
    void callFeedback(ft, !isOn, isOn ? 'toggle-off' : 'toggle-on');
  }

  return (
    <div
      style={{
        display: 'flex',
        flexWrap: 'wrap',
        gap: 8,
        alignItems: 'center',
        padding: '8px 0',
      }}
      role="group"
      aria-label="雷达候选反馈"
    >
      {ALL_TYPES.map((ft) => {
        const meta = FEEDBACK_LABELS[ft];
        const active = mine.includes(ft);
        const total = counts[ft] ?? 0;
        const isPending = pending === ft;
        return (
          <button
            key={ft}
            type="button"
            onClick={() => handleClick(ft)}
            disabled={isPending}
            aria-pressed={active}
            aria-label={`${meta.label}（${total}）`}
            style={{
              padding: '4px 10px',
              border: `1px solid ${active ? '#0f172a' : '#cbd5e1'}`,
              background: active ? '#0f172a' : '#fff',
              color: active ? '#fff' : '#334155',
              borderRadius: 16,
              cursor: isPending ? 'default' : 'pointer',
              fontSize: 13,
              opacity: isPending ? 0.6 : 1,
            }}
          >
            <span style={{ marginRight: 4 }}>{meta.icon}</span>
            {meta.label}
            <span style={{ marginLeft: 6, fontSize: 12, opacity: 0.75 }}>{total}</span>
          </button>
        );
      })}
      {err ? (
        <span role="alert" style={{ color: '#b91c1c', fontSize: 12, marginLeft: 8 }}>
          {err}
        </span>
      ) : null}
    </div>
  );
}

export const RADAR_FEEDBACK_TYPES_PUBLIC: readonly RadarFeedbackType[] = ALL_TYPES;