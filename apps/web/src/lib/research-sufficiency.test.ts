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
    expect(result.missing).toEqual(['Crawlee', 'Firecrawl']);
    expect(result.capturedSourceCount).toBe(1);
  });

  it('treats an explicitly covered comparison as sufficient without requiring a fixed source count', () => {
    const result = evaluateResearchSufficiency({
      brief: {
        objective: 'decide',
        comparisonOptions: ['Playwright', 'Crawlee'],
      },
      sources: [
        { title: 'Playwright docs', snippet: 'Playwright browser automation.' },
        { title: 'Crawlee docs', snippet: 'Crawlee web scraping framework.' },
      ],
    });

    expect(result).toMatchObject({
      status: 'sufficient',
      basis: 'explicit_comparison',
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
});
