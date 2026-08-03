'use client';

import type { DistilledScore } from '@deep-research/shared/schemas';
import { useState } from 'react';
import { ChevronDown } from 'lucide-react';

import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@/components/ui/tooltip';
import { TIER_LABELS, tierClasses } from '@/components/domain/ScoreBar';

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
  const tierVisual = tierClasses(score.tier);
  const tierLabel = TIER_LABELS[score.tier] ?? score.tier;

  if (compact) {
    return (
      <TooltipProvider delayDuration={120}>
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              type="button"
              className={`inline-flex h-7 shrink-0 items-center gap-1.5 rounded border bg-card px-2 font-mono text-xs font-semibold tabular-nums focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${tierVisual.border} ${tierVisual.text}`}
              aria-label={`Distilled 评分 ${score.total}，悬停查看详情`}
            >
              <span className="font-sans text-[11px] font-medium">Distilled</span>
              {score.total}
            </button>
          </TooltipTrigger>
          <TooltipContent side="bottom" align="start" className="w-72 max-w-[calc(100vw-2rem)] p-3">
            <ScoreDetails score={score} tierVisual={tierVisual} tierLabel={tierLabel} />
          </TooltipContent>
        </Tooltip>
      </TooltipProvider>
    );
  }

  return <ExpandedScorePanel score={score} tierVisual={tierVisual} tierLabel={tierLabel} />;
}

function ExpandedScorePanel({ score, tierVisual, tierLabel }: { score: DistilledScore; tierVisual: ReturnType<typeof tierClasses>; tierLabel: string }) {
  const [open, setOpen] = useState(false);

  return (
    <div className="border-y border-border">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="flex w-full items-center gap-2 bg-transparent py-2.5 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
      >
        <span
          className={`inline-flex h-7 shrink-0 items-center gap-1.5 rounded border bg-card px-2 font-mono text-xs font-semibold tabular-nums ${tierVisual.border} ${tierVisual.text}`}
        >
          <span className="font-sans text-[11px] font-medium">Distilled</span>
          {score.total}
        </span>
        <span className="text-xs text-muted-foreground">查看评分详情</span>
        <ChevronDown className={`ml-auto size-4 text-muted-foreground transition-transform ${open ? 'rotate-180' : ''}`} />
      </button>

      {open && (
        <div className="border-t border-border py-3">
          <ScoreDetails score={score} tierVisual={tierVisual} tierLabel={tierLabel} />
        </div>
      )}
    </div>
  );
}

function ScoreDetails({ score, tierVisual, tierLabel }: { score: DistilledScore; tierVisual: ReturnType<typeof tierClasses>; tierLabel: string }) {
  return (
    <div className="space-y-2 text-xs">
      <div className="flex items-center justify-between border-b border-border pb-2">
        <span className={`font-medium ${tierVisual.text}`}>{tierLabel}{score.mustRead ? ' · 必读' : ''}</span>
        <span className="text-muted-foreground">{score.profile}{score.isDefault ? ' · 默认评分' : ''}</span>
      </div>
      <div className="grid grid-cols-1 gap-x-5 gap-y-2 sm:grid-cols-2">
        {Object.entries(score.dimensions).map(([key, val]) => (
          <div key={key} className="flex min-w-0 items-center gap-2">
            <span className="w-16 shrink-0 truncate text-muted-foreground">
              {DIMENSION_LABELS[key] ?? key}
            </span>
            <span className="flex w-10 shrink-0 gap-0.5" aria-hidden>
              {[0, 1, 2].map((segment) => (
                <span
                  key={segment}
                  className={`h-1.5 flex-1 rounded-sm ${segment < val ? tierVisual.fill : 'bg-muted'}`}
                />
              ))}
            </span>
            <span className="w-6 shrink-0 font-mono text-right tabular-nums text-muted-foreground">
              {val}/3
            </span>
          </div>
        ))}
      </div>
      {score.weakPoint ? <p className="border-t border-border pt-2 text-muted-foreground"><span className="font-medium text-foreground">弱点：</span>{score.weakPoint}</p> : null}
      {score.veto ? <p className="text-destructive"><span className="font-medium">否决项：</span>{score.veto}</p> : null}
    </div>
  );
}
