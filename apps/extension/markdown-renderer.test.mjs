import assert from 'node:assert/strict';
import test from 'node:test';

import { parseMarkdownBlocks, streamingAnswerText, completeStreamingMarkdown } from './markdown-renderer.js';

test('streaming answer decodes JSON escapes without exposing the envelope', () => {
  assert.equal(streamingAnswerText('{"answer":"## Heading\\n\\n**Bold**\\n- One","evidence":['), '## Heading\n\n**Bold**\n- One');
  assert.equal(streamingAnswerText('{"answer":"Hello\\u4f'), 'Hello');
  assert.equal(streamingAnswerText('{"answer":"Hello\\u4f60\\n'), 'Hello你\n');
  assert.equal(streamingAnswerText('{"ans'), '');
  assert.equal(streamingAnswerText('An answer with [1] and `{x}`.'), 'An answer with [1] and `{x}`.');
});

test('streaming Markdown closes partial formatting and keeps completed blocks identical', () => {
  assert.equal(completeStreamingMarkdown('## Heading\n\nA **bold'), '## Heading\n\nA **bold**');
  assert.equal(completeStreamingMarkdown('A **'), 'A ');
  assert.equal(completeStreamingMarkdown('Code `value'), 'Code `value`');
  assert.equal(completeStreamingMarkdown('[Docs](https://example'), 'Docs');
  const complete = '## Heading\n\n**Bold** text\n\n- One\n- Two\n\n```js\nconst x = 1;\n```';
  assert.deepEqual(parseMarkdownBlocks(completeStreamingMarkdown(complete)), parseMarkdownBlocks(complete));
});

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

test('reader markdown separates inline summary headings from the long answer body', () => {
  const blocks = parseMarkdownBlocks(`1) 文章解决的问题和核心结论 文章指出的核心问题是审批流程成为新瓶颈，并建议将决策过程闭环化。\n\n## 2. 关键机制\n- 以版本化产物连接各阶段。\n\n---`);

  assert.deepEqual(blocks, [
    { type: 'numbered-heading', number: '1', content: '文章解决的问题和核心结论' },
    { type: 'paragraph', content: '文章指出的核心问题是审批流程成为新瓶颈，并建议将决策过程闭环化。' },
    { type: 'heading', level: 2, content: '2. 关键机制' },
    { type: 'unordered-list', items: ['以版本化产物连接各阶段。'] },
    { type: 'thematic-break' },
  ]);
});

test('reader markdown parser keeps GFM tables and ordered lists as structured blocks', () => {
  assert.deepEqual(
    parseMarkdownBlocks(`| 阶段 | 传统流程 | AI 原生流程 |
| --- | --- | --- |
| Test | 阶段门禁 | 连续评测 |

1. 先检查原文
2. 再核对译文`),
    [
      {
        type: 'table',
        header: ['阶段', '传统流程', 'AI 原生流程'],
        rows: [['Test', '阶段门禁', '连续评测']],
      },
      { type: 'ordered-list', items: ['先检查原文', '再核对译文'] },
    ],
  );
});

test('translation streams decode text without exposing the envelope', () => {
  assert.equal(streamingAnswerText('{"translation":"Hello\\nwor'), 'Hello\nwor');
  assert.equal(streamingAnswerText('{"transla'), '');
  assert.equal(streamingAnswerText('{"translation":"Hello\\u'), 'Hello');
});
