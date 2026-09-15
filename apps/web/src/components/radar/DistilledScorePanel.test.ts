import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { DistilledScorePanel } from './DistilledScorePanel';


describe('DistilledScorePanel', () => {
  it('shows the tier decision score as the primary score', () => {
    const html = renderToStaticMarkup(createElement(DistilledScorePanel, {
      score: {
        total: 35,
        rankingScore: 52.33,
        tierScore: 35,
        tier: 'noise',
        dimensions: {
          informationGain: 1,
          analysisDepth: 0,
          actionability: 1,
          factualReliability: 2,
          currentApplicability: 2,
          expressionQuality: 1,
          audienceFit: 2,
        },
        weakPoint: '分析深度=0分',
        veto: null,
        riskFlags: [],
        profile: 'engineering',
        isDefault: false,
        version: '4.7',
      },
    }));

    expect(html).toContain('Distilled</span>35');
    expect(html).not.toContain('Distilled</span>52.33');
  });

  it('shows the effective tier separately from a deferred score target', () => {
    const html = renderToStaticMarkup(createElement(DistilledScorePanel, {
      effectiveTier: 'skim',
      score: {
        total: 82,
        tierScore: 82,
        tier: 'deep_read',
        dimensions: {
          informationGain: 2,
          analysisDepth: 2,
          actionability: 2,
          factualReliability: 2,
          currentApplicability: 2,
          expressionQuality: 2,
          audienceFit: 2,
        },
        weakPoint: '',
        veto: null,
        riskFlags: [],
        profile: 'engineering',
        isDefault: false,
        version: '4.7',
      },
    }));

    expect(html).toContain('速览');
    expect(html).toContain('目标：推荐精读');
  });
});
