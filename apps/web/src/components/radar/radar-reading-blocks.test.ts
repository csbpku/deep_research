import { describe, expect, it } from 'vitest';

import { radarQuoteMatchesBlock, splitRadarReadingBlocks } from './radar-reading-blocks';

describe('splitRadarReadingBlocks', () => {
  it('does not split code fences at blank lines or treat comments as headings', () => {
    const blocks = splitRadarReadingBlocks(
      'Intro.\n\n~~~python\nfor result in results.objects:\n\n    # Weaviate reports the MaxSim score\n~~~\n\nAfter.',
    );

    expect(blocks).toHaveLength(3);
    expect(blocks[1]).toContain('~~~python');
    expect(blocks[1]).toContain('# Weaviate reports the MaxSim score');
  });

  it('preserves the contents of a standalone install command', () => {
    const blocks = splitRadarReadingBlocks(
      'Multi-vector models work with a plain install:\n\n~~~bash\npip install -U sentence-transformers\n~~~\n\nAfter.',
    );

    expect(blocks[1]).toBe('~~~bash\npip install -U sentence-transformers\n~~~');
  });

  it('keeps display math together', () => {
    const blocks = splitRadarReadingBlocks('Before.\n\n$$\nC=(m,v,q)\n$$\n\nAfter.');

    expect(blocks).toEqual(['Before.', '$$\nC=(m,v,q)\n$$', 'After.']);
  });

  it('requires the complete quote or both quote anchors in the same block', () => {
    const first = 'The system uses average fidelity loss to compare the learned distribution with the target distribution.';
    const second = 'The evaluation reports accuracy and cost across several benchmark settings.';

    expect(radarQuoteMatchesBlock(first, 'average fidelity loss to compare the learned distribution with the target distribution')).toBe(true);
    expect(radarQuoteMatchesBlock(first, 'The system uses average fidelity loss while the experiments report unrelated results')).toBe(false);
    expect(radarQuoteMatchesBlock(second, 'average fidelity loss to compare the learned distribution with the target distribution')).toBe(false);
  });

  it('does not accept a short or similar quote as a source anchor', () => {
    expect(radarQuoteMatchesBlock('This section discusses the model and its results.', 'model')).toBe(false);
    expect(radarQuoteMatchesBlock('The model improves retrieval quality in practice.', 'model improves retrieval quality in theory.')).toBe(false);
  });

  it('matches rendered text against Markdown and LaTeX source quotes', () => {
    expect(radarQuoteMatchesBlock(
      'Ventor-QTest reports an average fidelity loss for the target distribution.',
      String.raw`\textbf{[Ventor-QTest](https://huggingface.co/papers?q=Ventor-QTest)} reports an average fidelity loss for the target distribution.`,
    )).toBe(true);
  });
});
