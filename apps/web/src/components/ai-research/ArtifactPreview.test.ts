import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { ArtifactPreview } from './ArtifactPreview';

describe('ArtifactPreview', () => {
  it('renders slide-markdown sections as numbered slide surfaces', () => {
    const html = renderToStaticMarkup(createElement(ArtifactPreview, {
      content: '# Cover\n\n## Slide 2: Evidence\n\nEvidence.\n\n## Slide 3: Risks\n\nRisks.',
    }));

    expect(html).toContain('Slide 01');
    expect(html).toContain('Slide 02');
    expect(html).toContain('Slide 03');
    expect(html).toContain('Evidence.');
    expect(html).toContain('Risks.');
    expect(html).toContain('Slides 提纲预览');
    expect(html).toContain('3 页');
    expect(html).toContain('不是可下载的 .pptx 文件');
    expect(html).not.toContain('overflow-auto');
  });

  it('keeps long slide content readable instead of hiding it in a fixed canvas', () => {
    const html = renderToStaticMarkup(createElement(ArtifactPreview, {
      content: '# Cover\n\n## Slide 2: Decision\n\nA long decision note with evidence and caveats.',
    }));

    expect(html).toContain('第 2 页：Decision');
    expect(html).toContain('A long decision note with evidence and caveats.');
  });
});
