'use client';

import type { DistilledScore } from '@deep-research/shared/schemas';

const TIER_LABELS: Record<string, string> = {
  deep_read: '深读',
  skim: '速览',
  collection: '收录',
  noise: '噪音',
};

const TIER_COLORS: Record<string, string> = {
  deep_read: '#15803d',
  skim: '#0369a1',
  collection: '#64748b',
  noise: '#94a3b8',
};

const DIMENSION_LABELS: Record<string, string> = {
  informationGain: '信息增量',
  analysisDepth: '分析深度',
  actionability: '可操作性',
  factualReliability: '事实可靠',
  currentApplicability: '当下适用',
  expressionQuality: '表达质量',
  audienceFit: '受众匹配',
};

interface Props {
  score: DistilledScore;
  compact?: boolean;
}

export function DistilledScorePanel({ score, compact = false }: Props) {
  const tierColor = TIER_COLORS[score.tier] ?? '#64748b';
  const tierLabel = TIER_LABELS[score.tier] ?? score.tier;

  if (compact) {
    return (
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <div
          style={{
            width: 32,
            height: 32,
            borderRadius: '50%',
            border: `2px solid ${tierColor}`,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            fontSize: 13,
            fontWeight: 700,
            color: tierColor,
            flexShrink: 0,
          }}
        >
          {score.total}
        </div>
        <div>
          <span style={{ fontSize: 12, fontWeight: 600, color: tierColor }}>
            {tierLabel}
            {score.mustRead ? ' · 必读' : ''}
          </span>
          {score.weakPoint ? (
            <div style={{ fontSize: 11, color: '#64748b' }}>{score.weakPoint}</div>
          ) : null}
        </div>
      </div>
    );
  }

  return (
    <div
      style={{
        border: '1px solid #e2e8f0',
        borderRadius: 8,
        padding: 16,
        background: '#f8fafc',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 12 }}>
        <div
          style={{
            width: 48,
            height: 48,
            borderRadius: '50%',
            border: `3px solid ${tierColor}`,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            fontSize: 18,
            fontWeight: 700,
            color: tierColor,
          }}
        >
          {score.total}
        </div>
        <div>
          <div style={{ fontSize: 14, fontWeight: 600, color: tierColor }}>
            {tierLabel}
            {score.mustRead ? ' · 必读' : ''}
          </div>
          <div style={{ fontSize: 12, color: '#64748b' }}>
            {score.profile}
            {score.isDefault ? ' · 默认评分' : ''}
          </div>
        </div>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(140px, 1fr))', gap: 8 }}>
        {Object.entries(score.dimensions).map(([key, val]) => (
          <div key={key} style={{ fontSize: 12 }}>
            <div style={{ color: '#475569', marginBottom: 2 }}>
              {DIMENSION_LABELS[key] ?? key}
            </div>
            <div style={{ display: 'flex', gap: 2 }}>
              {[0, 1, 2, 3].map((i) => (
                <div
                  key={i}
                  style={{
                    width: 16,
                    height: 4,
                    borderRadius: 2,
                    background: i <= val ? tierColor : '#e2e8f0',
                  }}
                />
              ))}
            </div>
          </div>
        ))}
      </div>

      {score.weakPoint ? (
        <p style={{ fontSize: 12, color: '#64748b', marginTop: 12, marginBottom: 0 }}>
          短板：{score.weakPoint}
        </p>
      ) : null}

      {score.veto ? (
        <p style={{ fontSize: 12, color: '#b91c1c', marginTop: 4, marginBottom: 0 }}>
          一票否决：{score.veto}
        </p>
      ) : null}
    </div>
  );
}
