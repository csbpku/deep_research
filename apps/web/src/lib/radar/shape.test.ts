// Unit tests: W5 雷达 shape helper —— excerpt / parseUtcDate / isoDateOf / matchesQuery。
//
// 测试范围：
//   - excerpt 边界（短、长、有/无句号）
//   - parseUtcDate / isoDateOf 互逆
//   - matchesQuery 大小写、tag 命中、未命中
//   - aggregateFeedbacks 仅测试 counts/mine 聚合（mock prisma）

import { describe, expect, it, vi } from 'vitest';
import {
  excerptOf,
  classifyExcerptDisplay,
  parseUtcDate,
  isoDateOf,
  matchesQuery,
  aggregateFeedbacks,
  emptyFeedbackCounts,
  RADAR_FEEDBACK_TYPES,
  parseDistilledScore,
  parseHighlights,
  parseArxivAnalysis,
  parseGithubItemMeta,
  shapeCandidate,
} from './shape';

describe('excerptOf', () => {
  it('returns full body when shorter than max', () => {
    expect(excerptOf('Hello world.', 280)).toBe('Hello world.');
  });

  it('truncates at sentence boundary', () => {
    const long = 'First sentence. Second sentence is here. Third follows.';
    const result = excerptOf(long, 30);
    expect(result.length).toBeLessThanOrEqual(30);
    expect(result.endsWith('.')).toBe(true);
  });

  it('hard truncates with ellipsis if no boundary found', () => {
    const long = 'a'.repeat(500);
    const r = excerptOf(long, 50);
    expect(r.length).toBe(50);
    expect(r.endsWith('…')).toBe(true);
  });
});

describe('classifyExcerptDisplay', () => {
  it('returns clamp on empty input', () => {
    expect(classifyExcerptDisplay('')).toBe('clamp');
  });

  it('returns full for short single-paragraph content', () => {
    expect(classifyExcerptDisplay('Authors: Yipeng Zhao. Reasoning-Induced Misalignment, where fine-tuning on reasoning data containing no harmful content, including mathematics, code, and problem-solving with chain-of-thought traces can induce harmful behaviors of LLM.')).toBe('full');
  });

  it('returns full for arxiv-style abstract (long single paragraph)', () => {
    const abstract = 'Authors: Yipeng Zhao, Qishun Yang, Shenzhe Zhu, Shu Yang, Di Wang. Reasoning-Induced Misalignment, where fine-tuning on reasoning data containing no harmful content, including mathematics, code, and problem-solving with chain-of-thought traces can induce harmful behaviors of LLM, posing a serious challenge to the safety of LLM reasoning. Cross-architecture, cross-scale, and cross-dataset checks show that RIM does not always emerge.';
    expect(classifyExcerptDisplay(abstract)).toBe('full');
  });

  it('returns full when paragraph count is small (<= 3)', () => {
    const text = 'Para 1 with several sentences and content.\n\nPara 2 also with text.\n\nPara 3 closes it.';
    expect(classifyExcerptDisplay(text)).toBe('full');
  });

  it('returns clamp for dialogue-heavy content (many short paragraphs)', () => {
    const dialogue = [
      '\"I use IPython as my terminal\'s shell.\"',
      '\"IPython in the shell?\"',
      '\"No, IPython is the shell.\"',
      '\"IPython? As the shell?\"',
      '\"Only way to live.\"',
      '\"What about cat, ls, cd?\"',
      '\"I use those... But in IPython.\"',
      '\"Oh you are one of those `!` people...\"',
    ].join('\n\n');
    expect(classifyExcerptDisplay(dialogue)).toBe('clamp');
  });

  it('returns full when avg paragraph length >= 200 even with many paragraphs', () => {
    const longPara = 'Long paragraph with substantial content that goes on and on with detailed explanations about a topic, covering many aspects and going deep into the subject matter with extensive analysis and discussion that ensures the paragraph remains well above the 200 character threshold for the display classifier.';
    expect(longPara.length).toBeGreaterThanOrEqual(200);
    const text = Array.from({ length: 6 }).map(() => longPara).join('\n\n');
    expect(classifyExcerptDisplay(text)).toBe('full');
  });
});

describe('parseUtcDate / isoDateOf', () => {
  it('parseUtcDate returns UTC midnight', () => {
    const d = parseUtcDate('2026-07-21');
    expect(d.toISOString()).toBe('2026-07-21T00:00:00.000Z');
  });

  it('isoDateOf returns YYYY-MM-DD', () => {
    const d = new Date(Date.UTC(2026, 0, 5));
    expect(isoDateOf(d)).toBe('2026-01-05');
  });

  it('parse → iso roundtrip is stable', () => {
    expect(isoDateOf(parseUtcDate('2026-12-31'))).toBe('2026-12-31');
  });
});

describe('matchesQuery', () => {
  it('returns true when query is empty', () => {
    expect(matchesQuery({ query: undefined, title: 'X', interpretation: null, tags: [] })).toBe(true);
    expect(matchesQuery({ query: '', title: 'X', interpretation: null, tags: [] })).toBe(true);
  });

  it('matches title (case insensitive)', () => {
    expect(matchesQuery({
      query: 'RAG',
      title: 'RAG retrieval strategies',
      interpretation: null,
      tags: [],
    })).toBe(true);
    expect(matchesQuery({
      query: 'rag',
      title: 'RAG retrieval strategies',
      interpretation: null,
      tags: [],
    })).toBe(true);
  });

  it('matches interpretation', () => {
    expect(matchesQuery({
      query: 'vector',
      title: 'Foo',
      interpretation: 'covers vector store choices',
      tags: [],
    })).toBe(true);
  });

  it('matches repository identifiers across hyphens, spaces, and URL', () => {
    expect(matchesQuery({
      query: 'deepseek-harness',
      title: 'DeepSeek Harness',
      url: 'https://github.com/deepseek-ai/deepseek-harness',
      interpretation: null,
      tags: [],
    })).toBe(true);
    expect(matchesQuery({
      query: 'github.com/deepseek-ai/deepseek-harness',
      title: 'DeepSeek Harness',
      url: 'https://github.com/deepseek-ai/deepseek-harness',
      interpretation: null,
      tags: [],
    })).toBe(true);
  });

  it('matches tags', () => {
    expect(matchesQuery({
      query: 'postgres',
      title: 'Foo',
      interpretation: null,
      tags: ['Postgres', 'SQL'],
    })).toBe(true);
  });

  it('returns false on miss', () => {
    expect(matchesQuery({
      query: 'absent',
      title: 'Foo',
      interpretation: 'bar',
      tags: ['baz'],
    })).toBe(false);
  });
});

describe('RADAR_FEEDBACK_TYPES', () => {
  it('contains all five types', () => {
    expect([...RADAR_FEEDBACK_TYPES].sort()).toEqual(
      ['favorite', 'inaccurate', 'suggest_research', 'used', 'useful'],
    );
  });
});

describe('emptyFeedbackCounts', () => {
  it('returns all zero', () => {
    const c = emptyFeedbackCounts();
    expect(c).toEqual({ useful: 0, inaccurate: 0, used: 0, favorite: 0, suggest_research: 0 });
  });
});

describe('parseDistilledScore', () => {
  it('normalizes legacy snake_case v2 payloads', () => {
    const score = parseDistilledScore({
      total: 90,
      effective_total: 72,
      quality_score: 88,
      team_value_score: 66,
      ranking_score: 74,
      tier_score: 68,
      source_bonus: 8,
      tier: 'collection',
      dimensions: {
        info_increment: 3,
        analysis_depth: 2,
        actionability: 3,
        fact_credibility: 2,
        timeliness: 3,
        expression_quality: 3,
        audience_fit: 3,
      },
      weak_point: '缺少机制分析',
      veto: null,
      risk_flags: [],
      profile: 'engineering',
      is_default: false,
      version: '2.0',
      direct_relevance: 2,
      relevance_evidence: '可迁移到现有 RAG 管线',
    });

    expect(score?.total).toBe(90);
    expect(score?.rankingScore).toBe(74);
    expect(score?.tierScore).toBe(68);
    expect(score?.qualityScore).toBe(88);
    expect(score?.teamValueScore).toBe(66);
    expect(score?.sourceBonus).toBe(8);
    expect(score?.directRelevance).toBe(2);
    expect(score?.dimensions.analysisDepth).toBe(2);
    expect(score?.dimensions.currentApplicability).toBe(3);
    expect(score?.weakPoint).toBe('缺少机制分析');
  });
});

describe('parseHighlights', () => {
  it('shapes article enrichment and maps key_quote', () => {
    expect(parseHighlights({
      summary: '一句话摘要',
      highlights: ['亮点一', '', '亮点二'],
      key_quote: '关键原文',
    })).toEqual({
      summary: '一句话摘要',
      highlights: ['亮点一', '亮点二'],
      keyQuote: '关键原文',
    });
  });
});

describe('parseArxivAnalysis', () => {
  it('shapes the five-field paper analysis', () => {
    expect(parseArxivAnalysis({
      tldr: '一句话结论',
      motivation: '研究动机',
      method: '研究方法',
      result: '实验结果',
      conclusion: '最终结论',
    })).toEqual({
      tldr: '一句话结论',
      motivation: '研究动机',
      method: '研究方法',
      result: '实验结果',
      conclusion: '最终结论',
    });
  });
});

describe('parseGithubItemMeta', () => {
  it('shapes GitHub item metadata and limits comment previews', () => {
    const meta = parseGithubItemMeta({
      provider: 'github_item',
      kind: 'pr',
      owner: 'acme',
      repo: 'agent',
      numberOrTag: '7',
      state: 'open',
      labels: ['enhancement'],
      comments: 4,
      author: 'octocat',
      bodyPreview: 'Adds a streaming transport.',
      commentPreviews: [
        { author: 'a', body: 'First', createdAt: '2026-08-01T00:00:00Z' },
        { author: 'b', body: 'Second' },
        { author: 'c', body: 'Third' },
        { author: 'd', body: 'Fourth' },
      ],
    });

    expect(meta?.kind).toBe('pr');
    expect(meta?.bodyPreview).toBe('Adds a streaming transport.');
    expect(meta?.commentPreviews).toHaveLength(3);
    expect(meta?.commentPreviews[1]).toEqual({ author: 'b', body: 'Second', createdAt: null });
  });

  it('rejects unrelated metadata', () => {
    expect(parseGithubItemMeta({ provider: 'github', kind: 'issue' })).toBeNull();
  });
});

describe('shapeCandidate', () => {
  it('does not expose legacy GitHub activity data in the detail payload', () => {
    const shaped = shapeCandidate({
      summary: {
        id: 'summary-1',
        title: 'Repo',
        body: 'Body',
        url: 'https://github.com/acme/repo',
        tags: [],
        status: 'candidate',
        summaryDate: new Date('2026-08-26T00:00:00Z'),
        publishedAt: null,
        createdAt: new Date('2026-08-26T00:00:00Z'),
        interpretation: null,
        scoreReason: null,
        scoreVersion: null,
        relevanceScore: null,
        timelinessScore: null,
        sourceQualityScore: null,
        distilledScore: null,
        selectionReason: null,
        sortOrder: null,
        syncRunId: null,
        originalMeta: {
          zread: { status: 'complete' },
          githubUpdates: { items: [{ title: 'legacy activity' }] },
        },
      },
    });

    expect(shaped.originalMeta).toEqual({ zread: { status: 'complete' } });
  });
});

describe('aggregateFeedbacks', () => {
  it('aggregates counts and current-user mine', async () => {
    const groupBy = vi.fn().mockResolvedValue([
      { summaryId: 'a', feedbackType: 'useful', _count: { feedbackType: 3 } },
      { summaryId: 'a', feedbackType: 'favorite', _count: { feedbackType: 1 } },
      { summaryId: 'b', feedbackType: 'useful', _count: { feedbackType: 2 } },
    ]);
    const findMany = vi.fn().mockResolvedValue([
      { summaryId: 'a', feedbackType: 'favorite' },
    ]);
    const fakePrisma = { radarFeedback: { groupBy, findMany } };

    const map = await aggregateFeedbacks(fakePrisma, ['a', 'b'], 'u1');

    expect(groupBy).toHaveBeenCalledWith(expect.objectContaining({
      by: ['summaryId', 'feedbackType'],
      where: { summaryId: { in: ['a', 'b'] } },
    }));
    expect(findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { summaryId: { in: ['a', 'b'] }, userId: 'u1' },
    }));

    const a = map.get('a')!;
    expect(a.counts.useful).toBe(3);
    expect(a.counts.favorite).toBe(1);
    expect(a.mine).toEqual(['favorite']);

    const b = map.get('b')!;
    expect(b.counts.useful).toBe(2);
    expect(b.mine).toEqual([]);
  });

  it('returns empty map for empty input', async () => {
    const groupBy = vi.fn();
    const findMany = vi.fn();
    const fakePrisma = { radarFeedback: { groupBy, findMany } };
    const map = await aggregateFeedbacks(fakePrisma, [], 'u1');
    expect(map.size).toBe(0);
    expect(groupBy).not.toHaveBeenCalled();
    expect(findMany).not.toHaveBeenCalled();
  });
});
