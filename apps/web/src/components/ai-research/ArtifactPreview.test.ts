import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { ArtifactPreview, parseSlideComparison, parseExplicitSequence } from './ArtifactPreview';

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

describe('slide structure from source content', () => {
  it('compares only two explicitly titled sections and retains each source sentence', () => {
    expect(parseSlideComparison('### gather\n- 首错传播\n- 其余继续\n\n### TaskGroup\n- 取消其余\n- 汇总异常组')).toEqual([
      { title: 'gather', lines: ['首错传播', '其余继续'] },
      { title: 'TaskGroup', lines: ['取消其余', '汇总异常组'] },
    ]);
    expect(parseSlideComparison('- gather 继续\n- TaskGroup 取消')).toBeNull();
    expect(parseSlideComparison('### 一\nA\n### 二\nB\n### 三\nC')).toBeNull();
    expect(parseSlideComparison('```\n### A\n### B\n```')).toBeNull();
  });
  it('builds a process only from an explicit arrow sequence', () => {
    expect(parseExplicitSequence('任务失败 → 取消其余 → 汇总异常')).toEqual(['任务失败', '取消其余', '汇总异常']);
    expect(parseExplicitSequence('任务失败时，其他任务取消')).toBeNull();
  });
  it('keeps a trailing reference list out of the presentation excerpt while retaining it in the full list', () => {
    const html = renderToStaticMarkup(createElement(ArtifactPreview, { content: '## Slide 1: 结论\n\n- 任务完成。\n\n## 参考文献\n\n- 应在列表中的参考条目' }));
    const stage = html.split('data-slide-stage="true"')[1]!.split('aria-label="所有 Slides 内容"')[0]!;
    expect(stage).not.toContain('应在列表中的参考条目');
    expect(html).toContain('应在列表中的参考条目');
  });
});
