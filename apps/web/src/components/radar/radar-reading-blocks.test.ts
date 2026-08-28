import { describe, expect, it } from 'vitest';

import {
  decodeRadarTextEscapes,
  decodeRadarTextEntities,
  hasRadarReadingOutline,
  prepareRadarReadingContent,
  radarQuoteMatchesBlock,
  splitRadarReadingBlocks,
} from './radar-reading-blocks';

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

  it('does not let an extracted equation number merge adjacent prose and formulas into math', () => {
    const blocks = splitRadarReadingBlocks(String.raw`Proposition 1.

$$ \begin{split}\nabla_{\theta}\mathcal{R}_{\mathrm{query}}(\theta)&=\mathbb{E}_{q\sim\rho_{\theta}}\!\Big[\ell_{\theta}(q)\\&\cdot\nabla_{\theta}\ell_{\theta}(q)\Big].\end{split} $$

(7)
| --- | --- | --- | --- |

*which flows strictly through $\nabla_{\theta}\ell_{\theta}(q)$.*

#### Query reweighting.

$$ J_{\mathrm{ERPO}}(\theta)=\mathbb{E}_{q\sim\rho_{\theta_{0}}}[g(q)]. $$

(8)
| --- | --- | --- | --- |`);

    expect(blocks).toHaveLength(5);
    expect(blocks[1]).toContain(String.raw`\tag{7}`);
    expect(blocks[1]).not.toContain('which flows');
    expect(blocks[2]).toContain('which flows');
    expect(blocks[3]).toBe('#### Query reweighting.');
    expect(blocks[4]).toContain(String.raw`\tag{8}`);
  });
});

describe('prepareRadarReadingContent', () => {
  it('decodes HTML entities before comparing source and page titles', () => {
    const content = "# Granite 4.2 LLMs: How They're Built\n\n## Architecture\n\nBody.";
    expect(decodeRadarTextEntities('Granite 4.2 LLMs: How They&#39;re Built')).toBe(
      "Granite 4.2 LLMs: How They're Built",
    );
    expect(prepareRadarReadingContent(content, 'Granite 4.2 LLMs: How They&#39;re Built')).toBe(
      '## Architecture\n\nBody.',
    );
  });

  it('decodes literal JSON unicode escapes in Zread directory labels', () => {
    expect(decodeRadarTextEscapes(String.raw`Extensibility \u0026 Protocol`)).toBe(
      'Extensibility & Protocol',
    );
    expect(decodeRadarTextEscapes(String.raw`Core \\u0026 Runtime`)).toBe(
      'Core & Runtime',
    );
  });

  it('removes a repeated paper title and author front matter before Abstract', () => {
    const content = [
      '# A Longer Paper Title That Differs From the Radar Title',
      '',
      'Ada Lovelace',
      '',
      'Correspondence to: ada@example.com',
      '',
      '###### Abstract',
      '',
      'The paper body starts here.',
      '',
      '## 1 Introduction',
      '',
      'More body.',
    ].join('\n');

    expect(prepareRadarReadingContent(content, 'A Shorter Radar Title', true)).toBe(
      '###### Abstract\n\nThe paper body starts here.\n\n## 1 Introduction\n\nMore body.',
    );
  });

  it('makes arXiv prompt placeholders explicit in the reader', () => {
    const content = [
      '###### Abstract',
      '',
      'Appendix A',
      '',
      'Each template substitutes the product name s into a scenario-specific phrasing.',
      '',
      '推荐五款最值得买的 s (“Recommend the top five most worth-buying s”); within Digital Products, three products substitute',
      '',
      '推荐深圳最值得去的五家 s (“most worth-visiting s in Shenzhen”).',
    ].join('\n');

    const prepared = prepareRadarReadingContent(content, undefined, true);

    expect(prepared).toContain('Each template substitutes a product or service name into a scenario-specific phrasing.');
    expect(prepared).toContain('推荐五款最值得买的 [产品] (“Recommend the top five most worth-buying [product]”)');
    expect(prepared).toContain('推荐深圳最值得去的五家 [店铺/服务] (“most worth-visiting places/services in Shenzhen”)');
    expect(prepared).not.toContain('most worth-buying s');
  });

  it('repairs the known arXiv extraction word join in the reader', () => {
    const content = '###### Abstract\n\nWe curate five scenarios(Digital Products), each containing three * categoriesof 15 products*—225 real products.';

    expect(prepareRadarReadingContent(content, undefined, true)).toContain(
      'We curate five scenarios (Digital Products), each containing three categories of 15 products—225 real products.',
    );
  });

  it('removes a short lead when the following paragraph repeats and expands it', () => {
    const content = [
      '# Falcon TST',
      '',
      '蚂蚁国际日前正式发布自研时序AI预测大模型“鹰序TST”2.0版。',
      '',
      '蚂蚁国际日前正式发布自研时序AI预测大模型“鹰序TST”（FalconTST）2.0版，并公布更多细节。',
      '',
      '## 方法',
      '',
      '正文。',
    ].join('\n');

    const prepared = prepareRadarReadingContent(content, 'Falcon TST');
    expect(prepared).not.toContain('“鹰序TST”2.0版。\n\n蚂蚁国际');
    expect(prepared).toContain('并公布更多细节');
  });

  it('uses the source outline only for documents with multiple real sections', () => {
    expect(hasRadarReadingOutline('# Title\n\n## One\n\nBody\n\n## Two\n\nBody')).toBe(true);
    expect(hasRadarReadingOutline('# Title\n\nBody only.')).toBe(false);
    expect(hasRadarReadingOutline('# Paper\n\n###### Abstract\n\nBody\n\n## 1 Intro', true)).toBe(true);
  });
});

describe('radarQuoteMatchesBlock', () => {
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
