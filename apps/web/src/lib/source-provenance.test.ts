import { describe, expect, it } from 'vitest';

import { classifySourceProvenance } from './source-provenance';

describe('classifySourceProvenance', () => {
  it('labels first-party documentation and uses the host as its independence key', () => {
    expect(classifySourceProvenance({
      href: 'https://docs.python.org/3/installing/index.html',
      title: '部署文档',
      type: 'url',
    })).toEqual({ kind: 'official_docs', label: '官方文档', independentKey: 'docs.python.org' });
  });

  it('does not trust an advisory official-document type on a third-party mirror', () => {
    expect(classifySourceProvenance({
      href: 'https://w3cub.com/sqlite/lang.html',
      title: 'SQLite 文档镜像',
      type: 'official_document',
    })).toEqual({ kind: 'directory', label: '镜像/目录', independentKey: 'w3cub.com' });
    expect(classifySourceProvenance({
      href: 'https://unknown.example/docs/install',
      title: '官方安装文档',
      type: 'official_document',
    }).kind).toBe('web');
  });

  it('does not treat two pages from the same mirror as independent sources', () => {
    const first = classifySourceProvenance({ href: 'https://zread.ai/example/repo/page-a', title: 'A' });
    const second = classifySourceProvenance({ href: 'https://zread.ai/example/repo/page-b', title: 'B' });
    expect(first.kind).toBe('directory');
    expect(second.independentKey).toBe(first.independentKey);
  });

  it('keeps standards, repositories, papers, and community reports distinguishable', () => {
    expect(classifySourceProvenance({ href: 'https://www.rfc-editor.org/rfc/rfc9110', title: 'HTTP Semantics' }).label).toBe('标准/规范');
    expect(classifySourceProvenance({ href: 'https://github.com/example/project', title: '源代码' }).label).toBe('原始仓库');
    expect(classifySourceProvenance({ href: 'https://arxiv.org/abs/2401.00001', title: 'Paper' }).label).toBe('论文/预印本');
    expect(classifySourceProvenance({ href: 'https://stackoverflow.com/questions/1', title: '经验' }).label).toBe('社区经验');
  });
});
