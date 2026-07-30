// RadarCandidateCard —— 雷达候选卡（列表 / admin 队列共用）。
//
// 展示：来源图标 + 标题 + excerpt + 标签 + 评分 + AI 一句话解读 + 反馈条。
// 列表上整卡可点击进入详情；admin 队列提供额外操作按钮（select/dismiss）。

'use client';

import Link from 'next/link';
import { RadarFeedbackBar } from './RadarFeedbackBar';
import type { RadarFeedbackCounts } from './RadarFeedbackBar';
import type { RadarFeedbackType } from '@deep-research/shared/states';
import type { DistilledScore } from '@deep-research/shared/schemas';
import { DistilledScorePanel } from './DistilledScorePanel';

interface RadarCandidate {
  id: string;
  title: string;
  excerpt: string;
  url: string;
  sourceType: string | null;
  tags: string[];
  status: string;
  publishedAt: string | null;
  crawledAt: string;
  interpretation: string | null;
  scoreReason: string | null;
  relevanceScore: number | null;
  timelinessScore: number | null;
  sourceQualityScore: number | null;
  distilledScore: DistilledScore | null;
  selectionReason: string | null;
  sortOrder: number | null;
  feedbackCounts: RadarFeedbackCounts;
  myFeedbacks: RadarFeedbackType[];
}

interface RadarCandidateCardProps {
  candidate: RadarCandidate;
  /** Admin 操作按钮组（select/dismiss/retry）；不传则不展示 */
  adminActions?: React.ReactNode;
  onAskAi?: (
    summaryId: string,
    title: string,
    url: string,
    interpretation: string | null,
  ) => void;
}

function ScoreChip({ label, value }: { label: string; value: number | null }) {
  if (value === null) return null;
  return (
    <span
      title={`${label}: ${value.toFixed(2)}`}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 4,
        padding: '2px 8px',
        background: '#f1f5f9',
        color: '#334155',
        borderRadius: 10,
        fontSize: 12,
      }}
    >
      <span style={{ fontWeight: 600 }}>{label}</span>
      <span>{value.toFixed(2)}</span>
    </span>
  );
}

function SourceIcon({ sourceType }: { sourceType: string | null }) {
  const label = sourceType ?? 'unknown';
  return (
    <span
      style={{
        display: 'inline-block',
        padding: '2px 8px',
        border: '1px solid #cbd5e1',
        borderRadius: 12,
        fontSize: 11,
        color: '#475569',
        background: '#fff',
      }}
      aria-label={`来源类型 ${label}`}
    >
      {label}
    </span>
  );
}

function StatusBadge({ status }: { status: string }) {
  const map: Record<string, { color: string; bg: string; label: string }> = {
    candidate: { color: '#0f172a', bg: '#fef9c3', label: '候选' },
    published: { color: '#14532d', bg: '#dcfce7', label: '已发布' },
    rejected: { color: '#7f1d1d', bg: '#fee2e2', label: '已忽略' },
    archived: { color: '#475569', bg: '#e2e8f0', label: '已归档' },
    pending_review: { color: '#92400e', bg: '#fef3c7', label: '待审核' },
  };
  const m = map[status] ?? { color: '#475569', bg: '#e2e8f0', label: status };
  return (
    <span
      style={{
        padding: '2px 8px',
        background: m.bg,
        color: m.color,
        borderRadius: 12,
        fontSize: 11,
      }}
    >
      {m.label}
    </span>
  );
}

export function RadarCandidateCard({ candidate, adminActions, onAskAi }: RadarCandidateCardProps) {
  return (
    <article
      style={{
        border: '1px solid #e2e8f0',
        borderRadius: 8,
        background: '#fff',
        padding: 16,
        display: 'flex',
        flexDirection: 'column',
        gap: 8,
      }}
    >
      <header
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          flexWrap: 'wrap',
        }}
      >
        <SourceIcon sourceType={candidate.sourceType} />
        <StatusBadge status={candidate.status} />
        {candidate.sortOrder !== null ? (
          <span style={{ fontSize: 11, color: '#64748b' }}>#{candidate.sortOrder}</span>
        ) : null}
        <span style={{ marginLeft: 'auto', fontSize: 12, color: '#94a3b8' }}>
          {new Date(candidate.crawledAt).toISOString().slice(0, 10)}
        </span>
      </header>

      <Link
        href={`/radar/${candidate.id}`}
        style={{
          color: '#0f172a',
          textDecoration: 'none',
          fontSize: 16,
          fontWeight: 600,
          lineHeight: 1.4,
        }}
      >
        {candidate.title}
      </Link>

      {candidate.interpretation ? (
        <p
          style={{
            margin: 0,
            color: '#1e293b',
            fontSize: 13,
            lineHeight: 1.55,
            padding: '8px 12px',
            background: '#f8fafc',
            borderRadius: 4,
            borderLeft: '3px solid #0f172a',
          }}
        >
          <span style={{ color: '#64748b', fontSize: 11 }}>AI 一句话解读：</span>
          {candidate.interpretation}
        </p>
      ) : null}

      <p style={{ margin: 0, color: '#334155', fontSize: 14, lineHeight: 1.55 }}>
        {candidate.excerpt}
      </p>

      {candidate.tags.length > 0 ? (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
          {candidate.tags.map((t) => (
            <span
              key={t}
              style={{
                padding: '1px 8px',
                background: '#f1f5f9',
                color: '#475569',
                borderRadius: 10,
                fontSize: 11,
              }}
            >
              #{t}
            </span>
          ))}
        </div>
      ) : null}

      {candidate.distilledScore ? (
        <DistilledScorePanel score={candidate.distilledScore} compact />
      ) : (
        <div>
          <div style={{ marginBottom: 4, fontSize: 11, color: '#64748b' }}>启发式预筛分</div>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
            <ScoreChip label="相关性" value={candidate.relevanceScore} />
            <ScoreChip label="时效" value={candidate.timelinessScore} />
            <ScoreChip label="来源质量" value={candidate.sourceQualityScore} />
          </div>
        </div>
      )}

      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
        {candidate.scoreReason ? (
          <span
            title={candidate.scoreReason}
            style={{
              padding: '2px 8px',
              background: '#fff7ed',
              color: '#9a3412',
              borderRadius: 10,
              fontSize: 11,
              border: '1px solid #fed7aa',
            }}
          >
            理由：{candidate.scoreReason.length > 30
              ? candidate.scoreReason.slice(0, 30) + '…'
              : candidate.scoreReason}
          </span>
        ) : null}
      </div>

      {candidate.selectionReason ? (
        <p style={{ margin: 0, color: '#166534', fontSize: 13 }}>
          <strong style={{ color: '#14532d' }}>入选理由：</strong>
          {candidate.selectionReason}
        </p>
      ) : null}

      <RadarFeedbackBar
        summaryId={candidate.id}
        initialCounts={candidate.feedbackCounts}
        initialMine={candidate.myFeedbacks}
      />

      {onAskAi ? (
        <button
          type="button"
          onClick={() => onAskAi(
            candidate.id,
            candidate.title,
            candidate.url,
            candidate.interpretation,
          )}
          style={{
            alignSelf: 'flex-start',
            padding: '4px 10px',
            border: '1px solid #cbd5e1',
            borderRadius: 4,
            background: '#fff',
            color: '#475569',
            cursor: 'pointer',
            fontSize: 12,
          }}
        >
          💬 AI 讨论
        </button>
      ) : null}

      {adminActions ? (
        <div
          style={{
            display: 'flex',
            gap: 8,
            borderTop: '1px solid #e2e8f0',
            paddingTop: 8,
            flexWrap: 'wrap',
          }}
        >
          {adminActions}
        </div>
      ) : null}
    </article>
  );
}
