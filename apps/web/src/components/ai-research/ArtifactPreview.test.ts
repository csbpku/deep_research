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
  });
});
