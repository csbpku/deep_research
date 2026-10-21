import { describe, expect, it } from 'vitest';
import { summarizeAdminBulkResults } from './admin-bulk-results';

describe('summarizeAdminBulkResults', () => {
  it('reports a complete action and clears the failed selection', () => {
    expect(summarizeAdminBulkResults([{ id: 'a', ok: true }, { id: 'b', ok: true }], '恢复'))
      .toEqual({ message: '2 条内容已恢复', failedIds: [] });
  });

  it('reports both successful and failed items while retaining failed ids', () => {
    expect(summarizeAdminBulkResults([
      { id: 'a', ok: true },
      { id: 'b', ok: false, message: '当前状态不允许此操作' },
      { id: 'c', ok: false },
    ], '提升到雷达')).toEqual({
      message: '批量提升到雷达未全部完成：成功 1 条，失败 2 条。失败项已保留，可重试。 当前状态不允许此操作',
      failedIds: ['b', 'c'],
    });
  });

  it('does not lose failure feedback when every request fails', () => {
    expect(summarizeAdminBulkResults([{ id: 'a', ok: false }], '屏蔽'))
      .toEqual({ message: '批量屏蔽未全部完成：成功 0 条，失败 1 条。失败项已保留，可重试。', failedIds: ['a'] });
  });
});
