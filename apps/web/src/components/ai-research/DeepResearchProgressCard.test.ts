import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { DeepResearchProgressCard } from './DeepResearchProgressCard';

describe('research writer recovery status', () => {
  it('does not claim a recovered report exists after a provider timeout', () => {
    const html = renderToStaticMarkup(createElement(DeepResearchProgressCard, {
      savedSources: 48, capturedSources: 12,
      progress: {
        mode: 'deep', state: 'completed', round: 1, rounds: 2,
        branchesCompleted: 9, branchesTotal: 9,
        sourcesDiscovered: 48, sourcesCaptured: 12, pagesVisited: 48,
        reportWriteFallback: { reason: 'timeout_or_unavailable' },
      },
    }));
    expect(html).toContain('主报告写作超时或暂不可用');
    expect(html).toContain('已尝试根据本轮实际抓取的证据重写');
    expect(html).toContain('是否生成研究正文，以最终结果为准');
  });
});
