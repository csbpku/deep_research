import assert from 'node:assert/strict';
import test from 'node:test';

import { parseMarkdownBlocks } from './markdown-renderer.js';

test('reader markdown parser turns numbered summary sections and escaped bullets into blocks', () => {
  const blocks = parseMarkdownBlocks(`按四部分总结：

1) 文章解决的问题和核心结论
文章把代码之外的审批和交接流程识别为新的瓶颈。

2）关键机制或架构
- 公共机制：每个阶段提交一个可审计产物。
\\* Stage 3 Build：使用 plan mode。

3) 重要取舍
\\* Skills 是 advisory control。`);

  assert.deepEqual(
    blocks.map((block) => [block.type, block.number || null, block.content || block.items]),
    [
      ['paragraph', null, '按四部分总结：'],
      ['numbered-heading', '1', '文章解决的问题和核心结论'],
      ['paragraph', null, '文章把代码之外的审批和交接流程识别为新的瓶颈。'],
      ['numbered-heading', '2', '关键机制或架构'],
      ['unordered-list', null, ['公共机制：每个阶段提交一个可审计产物。', 'Stage 3 Build：使用 plan mode。']],
      ['numbered-heading', '3', '重要取舍'],
      ['unordered-list', null, ['Skills 是 advisory control。']],
    ],
  );
});
