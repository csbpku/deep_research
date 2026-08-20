import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import MarkdownContent, { prepareContent } from './MarkdownContent';

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
  });
});

// M8: prepareContent 的 isMarkdown 检测 —— 已格式化的 markdown 原样返回，
// 不触发 reflow 启发式；PDF/arXiv 纯文本才走启发式 reflow。
describe('MarkdownContent prepareContent', () => {
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
  });

  it('keeps extracted equation numbers attached to display math', () => {
    const input = 'Before.\n\n$$\nC=(m,v,q,\\phi,\\mathcal{E})\n$$\n\n(1)\n\nAfter.';
    const out = prepareContent(input);
    expect(out).toContain('\\tag{1}');
    expect(out).not.toMatch(/\$\$[\s\S]*\$\$\n\n\(1\)/u);
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
});
