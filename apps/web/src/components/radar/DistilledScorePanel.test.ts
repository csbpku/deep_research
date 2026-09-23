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
        version: '4.8',
      },
    }));

    expect(html).toContain('Distilled</span>35<span');
    expect(html).toContain('/100');
    expect(html).not.toContain('Distilled</span>52');
  });

  it('presents dimensions as rubric levels instead of a three-point exam score', () => {
    const html = renderToStaticMarkup(createElement(DistilledScorePanel, {
      embedded: true,
      score: {
        total: 76.67,
        tierScore: 76.67,
        tier: 'deep_read',
        dimensions: {
          informationGain: 2,
          analysisDepth: 1,
          actionability: 3,
          factualReliability: 2,
          currentApplicability: 2,
          expressionQuality: 2,
          audienceFit: 3,
        },
        weakPoint: '分析深度有限',
        veto: null,
        riskFlags: [],
        profile: 'engineering',
        isDefault: false,
        version: '4.8',
      },
    }));

    expect(html).toContain('分层分');
    expect(html).toContain('77<span');
    expect(html).toContain('突出');
    expect(html).toContain('扎实');
    expect(html).toContain('有限');
    expect(html).not.toContain('/3');
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
        version: '4.8',
      },
    }));

    expect(html).toContain('速览');
    expect(html).toContain('目标：推荐精读');
  });

  it('does not present a normal 2/3 score as a user-facing weakness', () => {
    const html = renderToStaticMarkup(createElement(DistilledScorePanel, {
      score: {
        total: 66.67,
        tier: 'skim',
        dimensions: {
          informationGain: 2,
          analysisDepth: 2,
          actionability: 2,
          factualReliability: 2,
          currentApplicability: 2,
          expressionQuality: 2,
          audienceFit: 2,
        },
        weakPoint: 'README极长，安全/操作/编辑器配置段落存在重复冗余',
        veto: null,
        riskFlags: [],
        profile: 'engineering',
        isDefault: false,
        version: '4.8',
      },
    }));

    expect(html).not.toContain('弱点：');
    expect(html).not.toContain('README极长');
  });
});
