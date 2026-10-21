import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { DistilledScorePanel } from './DistilledScorePanel';

function visibleText(html: string): string {
  return html
    .replace(/<style[\s\S]*?<\/style>/gu, ' ')
    .replace(/<[^>]*>/gu, ' ')
    .replace(/&nbsp;/gu, ' ')
    .replace(/&amp;/gu, '&')
    .replace(/&lt;/gu, '<')
    .replace(/&gt;/gu, '>')
    .replace(/\s+/gu, ' ')
    .trim();
}

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
    const text = visibleText(html);

    expect(text).toMatch(/Distilled\s*35\s*\/100/u);
    expect(text).not.toMatch(/Distilled\s*52/u);
    expect(html).toContain('data-score-display="expanded"');
    expect(html).toContain('aria-expanded="false"');
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
    const text = visibleText(html);

    expect(text).toContain('分层分');
    expect(text).toMatch(/77\s*\/100/);
    expect(text).toContain('突出');
    expect(text).toContain('扎实');
    expect(text).toContain('有限');
    expect(text).not.toContain('/3');
    expect(html).toContain('role="meter"');
    expect(html).toContain('aria-valuemax="3"');
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
    const text = visibleText(html);

    expect(text).toContain('速读');
    expect(text).toContain('目标：精读');
  });

  it('does not present a normal 2/3 score as a user-facing weakness', () => {
    const html = renderToStaticMarkup(createElement(DistilledScorePanel, {
      embedded: true,
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

    const text = visibleText(html);
    expect(text).not.toContain('弱点：');
    expect(text).not.toContain('README极长');
  });

  it('shows the source excerpt that grounds a weak-point note', () => {
    const html = renderToStaticMarkup(createElement(DistilledScorePanel, {
      embedded: true,
      score: {
        total: 55,
        tier: 'skim',
        dimensions: {
          informationGain: 2,
          analysisDepth: 2,
          actionability: 1,
          factualReliability: 2,
          currentApplicability: 2,
          expressionQuality: 2,
          audienceFit: 2,
        },
        weakPoint: '可行动性不足',
        weakPointEvidence: '文章没有可执行步骤',
        veto: null,
        riskFlags: [],
        profile: 'engineering',
        isDefault: false,
        version: '4.9',
      },
    }));
    const text = visibleText(html);

    expect(text).toContain('可行动性不足');
    expect(text).toContain('原文依据：文章没有可执行步骤');
  });

  it('exposes compact score context through a focusable neutral badge', () => {
    const html = renderToStaticMarkup(createElement(DistilledScorePanel, {
      compact: true,
      score: {
        total: 68,
        tierScore: 68,
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
        weakPoint: '',
        veto: null,
        riskFlags: [],
        profile: 'engineering',
        isDefault: true,
        version: '5.1',
      },
    }));
    const text = visibleText(html);

    expect(text).toMatch(/Distilled\s*68\s*\/100/u);
    expect(html).toContain('data-score-display="compact"');
    expect(html).toContain('role="note"');
    expect(html).toContain('tabindex="0"');
    expect(html).toContain('aria-label="Distilled 评分 68，当前层级 速读，聚焦或悬停查看详情"');
  });
});
