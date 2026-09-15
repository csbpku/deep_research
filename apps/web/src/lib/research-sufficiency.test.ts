import { describe, expect, it } from 'vitest';

import { evaluateResearchSufficiency } from './research-sufficiency';

describe('evaluateResearchSufficiency', () => {
  it('does not use a raw source count to claim that an explicit comparison is covered', () => {
    const result = evaluateResearchSufficiency({
      brief: {
        objective: 'decide',
        comparisonOptions: ['Playwright', 'Crawlee', 'Firecrawl'],
      },
      sources: [{
        title: 'Installation | Playwright',
        description: 'The Playwright documentation navigation and installation entry point.',
      }],
    });

    expect(result.status).toBe('insufficient');
    expect(result.missing).toEqual(expect.arrayContaining(['Crawlee', 'Firecrawl']));
    expect(result.matrix?.complete).toBe(false);
    expect(result.capturedSourceCount).toBe(1);
  });

  it('treats an explicitly covered comparison as sufficient without requiring a fixed source count', () => {
    const result = evaluateResearchSufficiency({
      brief: {
        objective: 'decide',
        comparisonOptions: ['Playwright', 'Crawlee'],
        decisionDimensions: ['能力'],
      },
      sources: [
        { title: 'Playwright docs', snippet: 'Playwright 能力：browser automation.' },
        { title: 'Crawlee docs', snippet: 'Crawlee 能力：web scraping framework.' },
      ],
    });

    expect(result).toMatchObject({
      status: 'sufficient',
      basis: 'decision_matrix',
      coveredCount: 2,
      requiredCount: 2,
    });
  });

  it('keeps a general research question unassessed rather than inventing a gap', () => {
    const result = evaluateResearchSufficiency({
      brief: { objective: 'investigate', comparisonOptions: [] },
      sources: [{ title: 'Official documentation', description: 'A direct source excerpt.' }],
    });

    expect(result.status).toBe('not_assessed');
    expect(result.basis).toBe('captured_source');
  });

  it('does not call an open-web run insufficient merely because the plan has no explicit matrix', () => {
    const result = evaluateResearchSufficiency({
      brief: null,
      sourcePolicy: 'prefer_user_sources',
      sources: [],
    });

    expect(result.status).toBe('not_assessed');
    expect(result.missing).toEqual([]);
  });

  it('requires evidence when the user locked the run to selected sources', () => {
    const result = evaluateResearchSufficiency({
      brief: null,
      sourcePolicy: 'only_user_sources',
      sources: [],
    });

    expect(result.status).toBe('insufficient');
    expect(result.missing).toEqual(['没有保存可核对的指定资料']);
  });

  it('preserves the difference between an official coverage gap and a claim verdict', () => {
    const result = evaluateResearchSufficiency({
      brief: null,
      sources: [{ title: 'Claude official docs', snippet: 'Captured body.' }],
      sourceCoverage: {
        claude: { label: 'Claude', captured: 1, requiredCaptured: 2, status: 'partial' },
      },
    });

    expect(result.status).toBe('insufficient');
    expect(result.basis).toBe('official_coverage');
    expect(result.items[0]).toMatchObject({ label: 'Claude', evidenceCount: 1, covered: false });
  });

  it('marks a missing operational cell as needs_test instead of allowing a complete comparison', () => {
    const result = evaluateResearchSufficiency({
      brief: {
        objective: 'decide',
        comparisonOptions: ['GHCR 固定 SHA 镜像', 'VPS 本地构建'],
        decisionDimensions: ['部署与构建', '回滚与恢复'],
      },
      sources: [{
        canonicalKey: 'https://docs.example.com/deploy',
        title: 'GHCR 固定 SHA 镜像部署',
        snippet: 'GHCR 固定 SHA 镜像支持部署与构建，并有 rollback 文档。',
      }],
    });
    expect(result.status).toBe('insufficient');
    expect(result.matrix?.cells).toEqual(expect.arrayContaining([
      expect.objectContaining({ option: 'VPS 本地构建', dimension: '部署与构建', state: 'needs_test' }),
      expect.objectContaining({ option: 'VPS 本地构建', dimension: '回滚与恢复', state: 'needs_test' }),
    ]));
  });

  it('does not close operational cells from keyword-only documentation', () => {
    const result = evaluateResearchSufficiency({
      brief: {
        objective: 'decide',
        comparisonOptions: ['VPS'],
        decisionDimensions: ['网络/性能实测', '磁盘与资源占用', '回滚与恢复'],
      },
      sources: [{
        canonicalKey: 'https://docs.example.com/vps',
        title: 'VPS deployment guide',
        snippet: 'VPS supports network performance, disk storage, image build cache, backup, and rollback.',
      }],
    });

    expect(result.status).toBe('insufficient');
    expect(result.matrix?.cells).toEqual(expect.arrayContaining([
      expect.objectContaining({ dimension: '网络/性能实测', state: 'needs_test', evidenceGap: expect.stringContaining('中位数') }),
      expect.objectContaining({ dimension: '磁盘与资源占用', state: 'needs_test', evidenceGap: expect.stringContaining('镜像空间') }),
      expect.objectContaining({ dimension: '回滚与恢复', state: 'needs_test', evidenceGap: expect.stringContaining('真实操作链路') }),
    ]));
  });

  it('closes operational cells only when the required measurements are recorded', () => {
    const result = evaluateResearchSufficiency({
      brief: {
        objective: 'decide',
        comparisonOptions: ['VPS'],
        decisionDimensions: ['网络/性能实测', '磁盘与资源占用', '回滚与恢复'],
      },
      sources: [{
        canonicalKey: 'https://ops.example.com/vps-runbook',
        title: 'VPS measured deployment and rollback runbook',
        snippet: [
          'VPS network speed test ran 5 times: median 80 Mbps, failure rate 0%, duration 60 seconds.',
          'Disk budget: image 2 GB, build cache 4 GB, backup 6 GB, rollback version 2 GB.',
          'Rollback: docker compose pull and docker compose up; elapsed time 45 seconds.',
        ].join(' '),
      }],
    });

    expect(result.status).toBe('sufficient');
    expect(result.matrix?.cells.every((cell) => cell.state === 'evidence')).toBe(true);
  });

  it('requires all structured recommendation fields for a decision report', () => {
    const result = evaluateResearchSufficiency({
      brief: { objective: 'decide', comparisonOptions: ['A'], decisionDimensions: ['能力'] },
      sources: [{ title: 'A 能力', snippet: 'A 能力已经有直接文档依据。' }],
      reportContent: [
        '- 推荐方案：A',
        '- 适用前提：有测试环境',
        '- 不推荐条件：无法接受成本',
        '- 置信度：中',
        '- 未确认风险：网络差异',
        '- 下一步验证动作：跑基准测试',
      ].join('\n'),
    });
    expect(result.status).toBe('sufficient');
    expect(result.recommendation.status).toBe('complete');
  });
});
