import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import MarkdownContent, { prepareContent } from './MarkdownContent';
import { cleanExtractedPlainText } from '@/lib/markdown-content';
import { isMermaidSource } from './MermaidDiagram';

describe('MarkdownContent links', () => {
  it('renders external references as visibly styled new-tab links', () => {
    const html = renderToStaticMarkup(
      createElement(MarkdownContent, {
        content: '## 参考文献\n\n1. Source. https://example.com/paper',
      }),
    );

    expect(html).toContain('href="https://example.com/paper"');
    expect(html).toContain('target="_blank"');
    expect(html).toContain('text-primary');
  });

  it('keeps footnote references and back links in the current page', () => {
    const html = renderToStaticMarkup(
      createElement(MarkdownContent, {
        content: '## 参考文献\n\n正文[^1]\n\n[^1]: Source. https://example.com/paper',
      }),
    );

    expect(html).toContain('href="#user-content-fn-1"');
    expect(html).not.toContain('href="#user-content-fn-1" target="_blank"');
    expect(html).toContain('data-footnote-backref');
    expect(html).toContain('href="https://example.com/paper"');
    expect(html).toContain('>Source.</a>');
  });

  it('does not render dangerous URL protocols or raw HTML', () => {
    const html = renderToStaticMarkup(
      createElement(MarkdownContent, {
        content: '[bad](javascript:alert(1))\n\n<span>raw</span>',
      }),
    );

    expect(html).not.toContain('javascript:');
    expect(html).not.toContain('<span>raw</span>');
    expect(html).toContain('bad');
    expect(html).toContain('raw');
  });

  it('renders safe remote article images lazily with their alt text', () => {
    const html = renderToStaticMarkup(
      createElement(MarkdownContent, {
        content: '![系统架构图](https://cdn.example.com/diagram.png)',
      }),
    );

    expect(html).toContain('src="https://cdn.example.com/diagram.png"');
    expect(html).toContain('alt="系统架构图"');
    expect(html).toContain('loading="lazy"');
    expect(html).not.toContain('data:image');
    expect(html).not.toMatch(/<p[^>]*>\s*<figure/u);
  });

  it('renders sanitized inline SVG images but rejects other data URLs', () => {
    const html = renderToStaticMarkup(
      createElement(MarkdownContent, {
        content: '![图形](data:image/svg+xml;base64,PHN2Zy8+#A1.F12)\n\n![不应保留](data:image/png;base64,broken)',
      }),
    );

    expect(html).toContain('src="data:image/svg+xml;base64,PHN2Zy8+#A1.F12"');
    expect(html).toContain('alt="图形"');
    expect(html).toContain('class="overflow-x-auto"');
    expect(html).toContain('lg:max-w-full');
    expect(html).toContain('aria-label="在新标签页查看原图"');
    expect(html).not.toContain('data:image/png');
  });

  it('does not render an arXiv page URL as a missing image', () => {
    const html = renderToStaticMarkup(
      createElement(MarkdownContent, {
        content: '![Refer to caption](https://arxiv.org/html/2608.20280)\n\n*Figure 1: unavailable*',
      }),
    );

    expect(html).not.toContain('src="https://arxiv.org/html/2608.20280"');
    expect(html).toContain('Figure 1: unavailable');
  });

  it('does not nest an anchor inside another anchor when an image sits inside a markdown link', () => {
    const html = renderToStaticMarkup(
      createElement(MarkdownContent, {
        content: '[![架构图](https://cdn.example.com/diagram.png)](https://example.com/page)',
      }),
    );

    // The outer markdown link must still wrap the image, but the click-to-zoom
    // anchor that the `img` handler normally adds must be suppressed so React
    // can hydrate the resulting DOM. A simple nested-anchor check via DOMParser
    // would be more accurate, but for SSR HTML a raw `<a>...<a>` substring
    // indicates the bug we are guarding against.
    expect(html).toContain('href="https://example.com/page"');
    expect(html).toContain('src="https://cdn.example.com/diagram.png"');
    expect(html).not.toContain('href="https://cdn.example.com/diagram.png"');
    expect(html).toMatch(/<a [^>]*href="https:\/\/example\.com\/page"[^>]*>[\s\S]*<\/a>/u);
  });

  it('preserves underscores inside linked image URLs', () => {
    const imageUrl = 'https://huggingface.co/datasets/example/resolve/main/mve_medical_model_size_ndcg.png';
    const html = renderToStaticMarkup(
      createElement(MarkdownContent, {
        content: `[![NDCG chart](${imageUrl})](${imageUrl})`,
      }),
    );

    expect(html).toContain(`src="${imageUrl}"`);
    expect(html).toContain(`href="${imageUrl}"`);
    expect(html).not.toContain('medical_ model_ size_');
  });

  it('repairs bare arXiv template variables in reader-facing text', () => {
    const prepared = prepareContent(
      '推荐五款最值得买的 s；推荐深圳最值得去的五家 s；Recommend the top five most worth-buying s',
    );

    expect(prepared).toContain('推荐五款最值得买的 [产品]');
    expect(prepared).toContain('推荐深圳最值得去的五家 [商家]');
    expect(prepared).toContain('Recommend the top five most worth-buying [product]');
    expect(prepared).not.toMatch(/worth-buying s\b/u);
  });

  it('removes image close markers and duplicated image captions', () => {
    const prepared = prepareContent([
      '✕![Latency chart](https://cdn.example.com/latency.png) Latency chart.This paragraph follows the image.',
      '',
      '✕',
      '![Throughput chart](https://cdn.example.com/throughput.png)',
    ].join('\n'));

    expect(prepared).toBe([
      '![Latency chart](https://cdn.example.com/latency.png)',
      '',
      'This paragraph follows the image.',
      '',
      '![Throughput chart](https://cdn.example.com/throughput.png)',
    ].join('\n'));
    expect(prepared).not.toContain('✕');
    expect(prepared).not.toContain('×');
  });

  it('decodes HTML entities and removes extraction-only paper footnotes', () => {
    const prepared = prepareContent('正文&nbsp;仍然可读。\n\n**footnotetext: Corresponding authors.**');

    expect(prepared).toContain('正文 仍然可读。');
    expect(prepared).not.toContain('&nbsp;');
    expect(prepared).not.toContain('footnotetext');
  });

  it('removes dagger-prefixed paper footnotes and plain-text LaTeX emphasis', () => {
    expect(prepareContent('正文。\n\n††footnotetext: Corresponding authors.')).not.toContain('footnotetext');
    expect(cleanExtractedPlainText(
      String.raw`\emph{weighted-additive combination} and \textbf{prediction-preserving repair}`,
    )).toBe('weighted-additive combination and prediction-preserving repair');
  });

  it('removes extracted footnote spans with numeric prefixes and figure boundaries', () => {
    const prepared = prepareContent([
      'Abstract text.',
      '00footnotetext: Equal contribution.  ‡Equal advising.',
      '![Figure 1](https://example.com/figure.svg)',
      '## 1 Introduction',
      '正文继续。',
    ].join('\n'));

    expect(prepared).not.toContain('footnotetext');
    expect(prepared).not.toContain('Equal contribution');
    expect(prepared).toContain('![Figure 1](https://example.com/figure.svg)');
    expect(prepared).toContain('## 1 Introduction');
  });
});

// M8: prepareContent 的 isMarkdown 检测 —— 已格式化的 markdown 原样返回，
// 不触发 reflow 启发式；PDF/arXiv 纯文本才走启发式 reflow。
describe('MarkdownContent prepareContent', () => {
  it('repairs escaped and tightly joined bold Markdown', () => {
    const input = String.raw`A **core ruleset**lives here, and \*\*lifecycle hooks\*\* inject it.`;
    expect(prepareContent(input)).toBe(
      'A **core ruleset** lives here, and **lifecycle hooks** inject it.',
    );
  });

  it('repairs a bold marker with a leading space after block splitting', () => {
    expect(prepareContent('and ** lifecycle hooks** inject it.')).toBe(
      'and **lifecycle hooks** inject it.',
    );
    expect(prepareContent('优先落地 **P0 引用治理** 三项')).toBe(
      '优先落地 **P0 引用治理** 三项',
    );
    expect(prepareContent('**P0 根基**，关键；**P1 "低负担"**，体验；**P2 持续研究**，演进。')).toBe(
      '**P0 根基**，关键；**P1 "低负担"**，体验；**P2 持续研究**，演进。',
    );
    const html = renderToStaticMarkup(createElement(MarkdownContent, {
      content: '**P0 根基**，关键；**P1 "低负担"**，体验；**P2 持续研究**，演进。',
    }));
    expect(html).toContain('<strong>P1 &quot;低负担&quot;</strong>');
    expect(html).not.toContain('** P1');
  });

  it('converts block math embedded in GFM table rows to valid inline math', () => {
    expect(prepareContent('| (4) | $$ \\\\widehat{D}=a-b. $$ |')).toContain(
      '| (4) | $\\displaystyle \\\\widehat{D}=a-b.$ |',
    );
    expect(prepareContent('| (4) | $$ \\\\widehat{D}=a-b. $$ |')).not.toContain('$$');
  });

  it('normalizes display-only constructs when equations are extracted into table cells', () => {
    const input = String.raw`| Formula |
| --- |
| $$ \begin{split}a&=b\\&=c\end{split}\tag{8} $$ |
| $$ {\color[rgb]{1,0,0}x} $$ |`;
    const prepared = prepareContent(input);
    const html = renderToStaticMarkup(createElement(MarkdownContent, { content: input }));

    expect(prepared).toContain(String.raw`\begin{aligned}`);
    expect(prepared).toContain(String.raw`\text{(8)}`);
    expect(prepared).toContain(String.raw`\color{#ff0000}`);
    expect(html).not.toContain('katex-error');
  });

  it('unwraps arXiv equation tables instead of rendering formulas as data tables', () => {
    const input = [
      '|  | $\\displaystyle u_{\\tau}$ | $\\displaystyle=\\mathbb{I}\\{\\mathcal{C}_{\\tau}\\},$ | $\\displaystyle a_{\\tau}$ | $\\displaystyle=\\mathbb{I}\\{\\mathcal{A}_{\\tau}\\},$ |  | (3.3) |',
      '| --- | --- | --- | --- | --- |',
      '|  | $\\displaystyle P_{d}$ | $\\displaystyle=\\{p_{1},\\ldots,p_{m}\\},$ |  |  | (1) |',
    ].join('\n');
    const prepared = prepareContent(input);
    const html = renderToStaticMarkup(createElement(MarkdownContent, { content: input }));

    expect(prepared).toContain('$$');
    expect(prepared).toContain(String.raw`\tag{1}`);
    expect(html).toContain('katex-display');
    expect(html).not.toContain('<table>');
  });

  it('drops empty table shells emitted before arXiv figures', () => {
    const input = '|  |\n| --- |\n\n![Figure](https://arxiv.org/html/2608.17286v1/figures/headline.png)';
    const html = renderToStaticMarkup(createElement(MarkdownContent, { content: input }));

    expect(html).not.toContain('<table>');
    expect(html).toContain('headline.png');
  });

  it('normalizes arXiv RGB colors and removes orphan table separators after equations', () => {
    const input = String.raw`$$
J=\mathbb{E}_{q\sim{\color[rgb]{1,0,0}\rho}}[g(q)].
$$

(8)
| --- | --- | --- | --- |`;
    const prepared = prepareContent(input);
    const html = renderToStaticMarkup(createElement(MarkdownContent, { content: input }));

    expect(prepared).toContain(String.raw`\color{#ff0000}`);
    expect(prepared).not.toContain('| --- |');
    expect(html).not.toContain('katex-error');
  });

  it('adds a missing GFM separator row to extracted tables', () => {
    const input = [
      '#### **表1 模型比较**| **模型** | **规模** | **结果** |',
      '| Falcon | 585M | 最优 |',
      '| Chronos | 120M | 次优 |',
    ].join('\n');
    const prepared = prepareContent(input);

    expect(prepared).toContain('| --- | --- | --- |');
    expect(prepared).toContain('#### **表1 模型比较**\n\n| **模型**');
    const html = renderToStaticMarkup(createElement(MarkdownContent, { content: input }));
    expect(html).toContain('<table>');
    expect(html).toContain('<strong>模型</strong>');
  });

  it('labels tables as horizontally scrollable on narrow screens', () => {
    const html = renderToStaticMarkup(createElement(MarkdownContent, {
      content: '| 名称 | 说明 |\n| --- | --- |\n| A | A long value |',
    }));

    expect(html).toContain('aria-label="可横向滚动的表格"');
    expect(html).toContain('表格可左右滑动查看');
  });

  it('returns authored markdown unchanged (headings + lists + bold)', () => {
    const md = '# Title\n\n## Section\n\n- item one\n- item two\n\n**bold text** with a [link](https://example.com)';
    expect(prepareContent(md)).toBe(md);
  });

  it('returns GitHub README-style markdown unchanged (code fence)', () => {
    const md = '# Project\n\n```ts\nconst x = 1;\n```\n\nInstall with `npm i`';
    expect(prepareContent(md)).toBe(md);
  });

  it('keeps hash-prefixed code comments inside tilde fences', () => {
    const md = '~~~python\nfor result in results.objects:\n    # Weaviate reports the MaxSim score as a negated distance\n~~~';
    const html = renderToStaticMarkup(createElement(MarkdownContent, { content: md }));
    expect(html).toContain('class="hljs language-python"');
    expect(html).not.toContain('<h1>Weaviate reports');
  });

  it('does NOT reflow bold-only / link-only paragraphs (M8 fix)', () => {
    // 只有 **bold** 和 [link](url) 的段落也应识别为 markdown，不走 reflow
    const md = 'This is **bold** text.\n\nSee the [official docs](https://example.com) for details.';
    expect(prepareContent(md)).toBe(md);
  });

  it('joins web-extracted inline fragments back into one readable paragraph', () => {
    const input = '[previous post](https://example.com), we compared\n\n**with**\n\n[ALTK-Evolve](https://example.com/altk)\n[ACE](https://arxiv.org/abs/2510.04618)and showed that\n\n*how much*should you give it?';
    const out = prepareContent(input);
    expect(out).toContain('[previous post](https://example.com), we compared **with** [ALTK-Evolve](https://example.com/altk) [ACE](https://arxiv.org/abs/2510.04618) and showed that *how much* should you give it?');
    expect(out).not.toMatch(/compared\n\n\*\*with\*\*/u);
    expect(prepareContent('** Agentic memory** and * how*you').replace(/\n/g, ' ')).toContain('**Agentic memory** and *how* you');
  });

  it('repairs the known arXiv category word join before rendering', () => {
    const input = 'We curate five *scenarios*(Digital Products), each containing three * categories*of 15 * products*—225 real products.';
    const html = renderToStaticMarkup(createElement(MarkdownContent, { content: input }));

    expect(html).toContain('<em>scenarios</em> (Digital Products)');
    expect(html).toContain('categories of 15 products');
    expect(html).not.toContain('categoriesof');
    expect(html).not.toContain('* categories');
  });

  it('keeps spaces after italic fragments in arXiv abstracts', () => {
    const input = 'We ask: *to what extent do models help with results?*To answer this, we introduce FORGE. We evaluate three defenses: *skepticism prompting*and *consensus filtering* (over model priors).';
    expect(prepareContent(input)).toContain('results?* To answer');
    expect(prepareContent(input)).toContain('prompting* and *consensus');
  });

  it('keeps inline labels such as TL;DR on their own line', () => {
    const out = prepareContent('The setup is simple:\n\n** TL;DR**\n\n- one point');
    expect(out).toContain('The setup is simple:\n\n**TL;DR**\n\n- one point');
  });

  it('splits a flattened TL;DR label from its takeaway', () => {
    const out = prepareContent('** TL;DR- **ALTK-Evolve** lets an agent learn from its own past trajectories.');
    expect(out).toContain('**TL;DR**\n\n- **ALTK-Evolve** lets an agent learn from its own past trajectories.');
    expect(prepareContent('Intro.\n** TL;DR- The takeaway starts here.')).toContain('Intro.\n**TL;DR**\n\nThe takeaway starts here.');
    expect(prepareContent('** TL;DR: The takeaway starts here.')).toContain('**TL;DR**\n\nThe takeaway starts here.');
  });

  it('reflows PDF-style plain text (no markdown markers)', () => {
    const plain = 'This is a long plain text paragraph that should be reflowed. It has no markdown markers.';
    const out = prepareContent(plain);
    expect(out).toContain('This is a long plain text');
  });

  it('normalizes common LaTeX emphasis and links from arXiv extraction', () => {
    const input = String.raw`\textbf{[Ventor-QTest](https://example.com)} and \url{https://arxiv.org/abs/1234.5678}`;
    const out = prepareContent(input);
    expect(out).toContain('**[Ventor-QTest](https://example.com)**');
    expect(out).toContain('<https://arxiv.org/abs/1234.5678>');
    expect(out).not.toContain('\\textbf');
  });

  it('renders inline and display math with KaTeX', () => {
    const html = renderToStaticMarkup(
      createElement(MarkdownContent, {
        content: 'Inline $x^2$\n\n$$\nC=(m,v,q)\n$$',
      }),
    );
    expect(html).toContain('class="katex"');
    expect(html).toContain('katex-display');
    expect(html).not.toContain('katex-mathml');
  });

  it('keeps extracted equation numbers attached to display math', () => {
    const input = 'Before.\n\n$$\nC=(m,v,q,\\phi,\\mathcal{E})\n$$\n\n(1)\n\nAfter.';
    const out = prepareContent(input);
    expect(out).toContain('\\tag{1}');
    expect(out).not.toMatch(/\$\$[\s\S]*\$\$\n\n\(1\)/u);
  });

  it('does not attach an equation number across intervening prose and formulas', () => {
    const input = String.raw`$$ \begin{split}a&=b\\&=c\end{split} $$

(7)
| --- | --- | --- | --- |

*which flows through $a$ without constraining $b$.*

#### Next objective

$$ J=\mathbb{E}[g(q)]. $$

(8)
| --- | --- | --- | --- |`;
    const prepared = prepareContent(input);
    const html = renderToStaticMarkup(createElement(MarkdownContent, { content: input }));

    expect(prepared).toContain(String.raw`\tag{7}`);
    expect(prepared).toContain(String.raw`\tag{8}`);
    expect(prepared).not.toMatch(/\\tag\{8\}[\s\S]*which flows/u);
    expect(html).not.toContain('katex-error');
  });

  it('keeps paper reference links on-page for hover preview lookup', () => {
    const html = renderToStaticMarkup(
      createElement(MarkdownContent, {
        content: '[1](#bib.bib1)\n\n## References\n\n<a id="bib.bib1">Paper title</a>',
      }),
    );
    expect(html).toContain('href="#bib.bib1"');
    expect(html).not.toContain('target="_blank"');
  });

  it('repairs the doubled relation-bar escape used by some arXiv extracts', () => {
    const input = String.raw`$$ L_{r,b}=D_{\mathrm{KL}}\!\left(T_xQ_{r,b}\,\middle\\|\,T_xP\right) $$`;
    const out = prepareContent(input);
    expect(out).toContain(String.raw`\middle|`);
    expect(out).not.toContain(String.raw`\middle\\|`);
    const html = renderToStaticMarkup(createElement(MarkdownContent, { content: input }));
    expect(html).toContain('class="katex"');
    expect(html).not.toContain('katex-error');
  });

  it('repairs extracted currency text and stray table delimiters', () => {
    const input = String.raw`$$
C=\text{$}0.0033.\tag{22}
$$

S_{r}\in{0.12}, $$ |  |`;
    const html = renderToStaticMarkup(createElement(MarkdownContent, { content: input }));
    expect(html).not.toContain('katex-error');
    expect(html).toContain('0.0033');
  });

  it('removes unescaped TeX comments inside math without touching escaped percent signs', () => {
    const input = String.raw`$$
x = 1 % extractor comment
y = 2\%
$$`;
    const prepared = prepareContent(input);

    expect(prepared).toContain('x = 1');
    expect(prepared).not.toContain('extractor comment');
    expect(prepared).toContain(String.raw`y = 2\%`);
    expect(renderToStaticMarkup(createElement(MarkdownContent, { content: input }))).not.toContain('katex-error');
  });
});

describe('Mermaid detection', () => {
  it('recognizes common diagram sources without confusing ordinary code for a diagram', () => {
    expect(isMermaidSource('flowchart TB\nA --> B')).toBe(true);
    expect(isMermaidSource('sequenceDiagram\nAlice->>Bob: Hello')).toBe(true);
    expect(isMermaidSource('const graph = true;')).toBe(false);
  });
});
