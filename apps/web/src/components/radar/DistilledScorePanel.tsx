'use client';

import type { DistilledScore } from '@deep-research/shared/schemas';
import React, { useId, useState } from 'react';
import { ChevronDown } from 'lucide-react';
import Box from '@mui/material/Box';
import ButtonBase from '@mui/material/ButtonBase';
import Chip from '@mui/material/Chip';
import Collapse from '@mui/material/Collapse';
import Paper from '@mui/material/Paper';
import Tooltip from '@mui/material/Tooltip';
import Typography from '@mui/material/Typography';
import { space, tokens } from '@deep-research/design-system';

import { TIER_LABELS, readingTierColor } from '@/components/domain/ScoreBar';

const DIMENSION_ORDER = [
  'informationGain',
  'analysisDepth',
  'actionability',
  'factualReliability',
  'currentApplicability',
  'expressionQuality',
  'audienceFit',
] as const satisfies readonly (keyof DistilledScore['dimensions'])[];

const DIMENSION_LABELS: Record<(typeof DIMENSION_ORDER)[number], string> = {
  informationGain: '信息增量',
  analysisDepth: '分析深度',
  actionability: '可操作性',
  factualReliability: '事实可靠',
  currentApplicability: '当下适用',
  expressionQuality: '表达质量',
  audienceFit: '受众匹配',
};

const DIMENSION_LEVELS = ['不足', '有限', '扎实', '突出'] as const;

function formatScore(value: number): string {
  return String(Math.round(value));
}

interface Props {
  score: DistilledScore;
  compact?: boolean;
  embedded?: boolean;
  /** Effective persisted tier; score.tier remains the score-derived target. */
  effectiveTier?: string | null;
}

export function DistilledScorePanel({ score, compact = false, embedded = false, effectiveTier }: Props) {
  const displayTier = effectiveTier || score.tier;
  const tierColor = readingTierColor(displayTier);
  const tierLabel = TIER_LABELS[displayTier] ?? displayTier;
  const targetTierLabel = effectiveTier && effectiveTier !== score.tier
    ? TIER_LABELS[score.tier] ?? score.tier
    : null;
  const displayScore = score.tierScore ?? score.total;

  if (embedded) {
    return (
      <ScoreDetails
        score={score}
        tierColor={tierColor}
        tierLabel={tierLabel}
        targetTierLabel={targetTierLabel}
      />
    );
  }

  if (compact) {
    return (
      <Tooltip
        placement="bottom-start"
        title={(
          <Box sx={{ width: '288px', maxWidth: 'calc(100vw - 32px)', padding: space.md }}>
            <ScoreDetails
              score={score}
              tierColor={tierColor}
              tierLabel={tierLabel}
              targetTierLabel={targetTierLabel}
            />
          </Box>
        )}
      >
        <Chip
          role="note"
          tabIndex={0}
          size="small"
          variant="outlined"
          label={<ScorePillLabel score={displayScore} />}
          aria-label={`Distilled 评分 ${displayScore}，当前层级 ${tierLabel}，聚焦或悬停查看详情`}
          data-score-display="compact"
          sx={scorePillSx(tierColor)}
        />
      </Tooltip>
    );
  }

  return (
    <ExpandedScorePanel
      score={score}
      tierColor={tierColor}
      tierLabel={tierLabel}
      targetTierLabel={targetTierLabel}
    />
  );
}

function ScorePillLabel({ score }: { score: number }) {
  return (
    <Box component="span" sx={{ display: 'inline-flex', alignItems: 'baseline', gap: space.xs, whiteSpace: 'nowrap' }}>
      <Typography component="span" variant="metadata" sx={{ fontWeight: 500 }}>Distilled</Typography>
      <Typography component="span" variant="control" sx={{ fontFamily: 'monospace', fontVariantNumeric: 'tabular-nums' }}>{formatScore(score)}</Typography>
      <Typography component="span" variant="metadata">/100</Typography>
    </Box>
  );
}

function scorePillSx(tierColor: string) {
  return {
    maxWidth: '100%',
    minHeight: '28px',
    height: 'auto',
    color: tierColor,
    borderColor: 'currentColor',
    bgcolor: 'background.paper',
    fontVariantNumeric: 'tabular-nums',
    '& .MuiChip-label': { display: 'inline-flex', minWidth: 0, paddingInline: space.sm, whiteSpace: 'nowrap' },
  } as const;
}

function ExpandedScorePanel({
  score,
  tierColor,
  tierLabel,
  targetTierLabel,
}: {
  score: DistilledScore;
  tierColor: string;
  tierLabel: string;
  targetTierLabel: string | null;
}) {
  const [open, setOpen] = useState(false);
  const detailsId = useId();
  const displayScore = score.tierScore ?? score.total;

  return (
    <Paper variant="outlined" data-score-display="expanded" sx={{ overflow: 'hidden', bgcolor: 'action.hover', borderRadius: tokens['radius-small'] }}>
      <ButtonBase
        component="button"
        type="button"
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
        aria-controls={detailsId}
        sx={{
          display: 'flex', width: '100%', minWidth: 0, minHeight: 'var(--dr-control-height)',
          flexWrap: 'wrap', alignItems: 'center', gap: space.sm, padding: space.sm,
          textAlign: 'left', justifyContent: 'flex-start',
          '@media (pointer: coarse)': { minHeight: 'var(--dr-touch-target)' },
        }}
      >
        <Chip size="small" variant="outlined" label={<ScorePillLabel score={displayScore} />} sx={scorePillSx(tierColor)} />
        <Typography component="span" variant="metadata" color="text.secondary">
          {open ? '收起评分详情' : '查看评分详情'}
        </Typography>
        <Typography component="span" variant="metadata" sx={{ color: tierColor, fontWeight: 500 }}>{tierLabel}</Typography>
        {targetTierLabel ? (
          <Typography component="span" variant="metadata" color="text.secondary">目标：{targetTierLabel}</Typography>
        ) : null}
        <ChevronDown
          aria-hidden="true"
          size={16}
          style={{ marginLeft: 'auto', flexShrink: 0, color: 'var(--dr-color-text-secondary)', transform: open ? 'rotate(180deg)' : undefined, transition: 'transform var(--dr-motion-fast)' }}
        />
      </ButtonBase>

      <Collapse in={open} timeout="auto">
        <Box id={detailsId} role="region" aria-label="评分依据" sx={{ borderTop: 1, borderColor: 'divider', padding: space.md }}>
          <ScoreDetails
            score={score}
            tierColor={tierColor}
            tierLabel={tierLabel}
            targetTierLabel={targetTierLabel}
          />
        </Box>
      </Collapse>
    </Paper>
  );
}

function ScoreDetails({
  score,
  tierColor,
  tierLabel,
  targetTierLabel,
}: {
  score: DistilledScore;
  tierColor: string;
  tierLabel: string;
  targetTierLabel: string | null;
}) {
  const dimensions = DIMENSION_ORDER.map((key) => [key, score.dimensions[key]] as const);
  const minDimension = Math.min(...dimensions.map(([, value]) => value));
  const showWeakPoint = Boolean(
    score.weakPoint
      && (minDimension < 2 || score.veto || score.riskFlags.length > 0),
  );

  return (
    <Box component="section" data-score-details sx={{ display: 'grid', gap: space.sm, minWidth: 0 }}>
      <Box component="header" sx={{ display: 'flex', flexWrap: 'wrap', alignItems: 'baseline', justifyContent: 'space-between', columnGap: space.md, rowGap: space.xs, borderBottom: 1, borderColor: 'divider', paddingBottom: space.sm }}>
        <Typography component="span" variant="control" sx={{ color: tierColor, fontWeight: 500 }}>
          {tierLabel}
          {targetTierLabel ? <Typography component="span" variant="metadata" color="text.secondary" sx={{ marginLeft: space.sm }}>目标：{targetTierLabel}</Typography> : null}
        </Typography>
        <Typography component="span" variant="metadata" color="text.secondary">
          {score.profile}{score.isDefault ? ' · 默认评分' : ''}
        </Typography>
      </Box>

      {score.tierScore !== undefined || score.rankingScore !== undefined ? (
        <Box sx={{ display: 'grid', gridTemplateColumns: 'repeat(3, minmax(0, 1fr))', gap: space.xs, borderBottom: 1, borderColor: 'divider', paddingBottom: space.sm, textAlign: 'center' }}>
          <ScoreMetric label="分层分" value={score.tierScore ?? score.total} />
          <ScoreMetric label="排序分" value={score.rankingScore} />
          <ScoreMetric label="内容质量" value={score.qualityScore ?? score.total} />
        </Box>
      ) : null}

      <Box sx={{ display: 'grid', gap: space.sm }}>
        {dimensions.map(([key, value]) => (
          <Box key={key} sx={{ display: 'grid', gridTemplateColumns: 'minmax(0, 5fr) minmax(0, 7fr) auto', alignItems: 'center', gap: space.sm, minWidth: 0 }}>
            <Typography component="span" variant="metadata" color="text.secondary" sx={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {DIMENSION_LABELS[key] ?? key}
            </Typography>
            <Box
              role="meter"
              aria-label={DIMENSION_LABELS[key] ?? key}
              aria-valuenow={value}
              aria-valuemin={0}
              aria-valuemax={3}
              aria-valuetext={DIMENSION_LEVELS[value] ?? '未知'}
              sx={{ display: 'grid', gridTemplateColumns: 'repeat(3, minmax(0, 1fr))', gap: '2px', minWidth: 0 }}
            >
              {[0, 1, 2].map((segment) => (
                <Box
                  key={segment}
                  component="span"
                  aria-hidden="true"
                  sx={{ height: '5px', borderRadius: '2px', bgcolor: segment < value ? tierColor : 'var(--dr-color-tier-track)' }}
                />
              ))}
            </Box>
            <Typography component="span" variant="metadata" color="text.secondary" sx={{ minWidth: '40px', textAlign: 'right', whiteSpace: 'nowrap' }}>
              {DIMENSION_LEVELS[value] ?? '未知'}
            </Typography>
          </Box>
        ))}
      </Box>

      {showWeakPoint ? (
        <Box sx={{ borderTop: 1, borderColor: 'divider', paddingTop: space.sm, color: 'text.secondary' }}>
          <Typography component="p" variant="metadata" sx={{ margin: 0 }}>
            <Box component="span" sx={{ color: 'text.primary', fontWeight: 500 }}>弱点：</Box>{score.weakPoint}
          </Typography>
          {score.weakPointEvidence ? (
            <Typography component="p" variant="metadata" color="text.secondary" sx={{ margin: `${space.xs} 0 0`, borderLeft: 2, borderColor: 'divider', paddingLeft: space.sm, overflowWrap: 'anywhere' }}>
              原文依据：{score.weakPointEvidence}
            </Typography>
          ) : null}
        </Box>
      ) : null}
      {score.veto ? (
        <Typography component="p" variant="metadata" color="error.main" sx={{ margin: 0 }}>
          <Box component="span" sx={{ fontWeight: 500 }}>否决项：</Box>{score.veto}
        </Typography>
      ) : null}
    </Box>
  );
}

function ScoreMetric({ label, value }: { label: string; value?: number }) {
  return (
    <Box sx={{ minWidth: 0 }}>
      <Typography component="div" variant="control" sx={{ fontFamily: 'monospace', fontWeight: 600, fontVariantNumeric: 'tabular-nums' }}>
        {value === undefined ? '-' : <>{formatScore(value)}<Typography component="span" variant="metadata" color="text.secondary" sx={{ fontFamily: 'inherit', fontWeight: 400 }}>/100</Typography></>}
      </Typography>
      <Typography component="div" variant="metadata" color="text.secondary" sx={{ whiteSpace: 'nowrap' }}>{label}</Typography>
    </Box>
  );
}
