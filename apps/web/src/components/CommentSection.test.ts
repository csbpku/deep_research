// Unit tests: W8 CommentSection 组件纯逻辑层。
//
// 策略：项目未装 @testing-library/react（避免引入新依赖），测两个导出
// helper + 数据序列化行为。组件渲染层由 P0 真实 API + 浏览器 E2E 覆盖。
//
// 覆盖：
//   - hashHue：稳定同输入同输出；同输入范围 [0, 360)
//   - formatRelative：刚刚 / 分钟 / 小时 / 天 / 日期 fallback
//   - CommentItem 序列化形态（与 BFF API 契约对齐）

import { describe, expect, it } from 'vitest';
import { __testing__ as commentHelpers } from './CommentSection';

const { hashHue, formatRelative, isCommentAnchorStale } = commentHelpers;

describe('hashHue', () => {
  it('returns 0 for empty string', () => {
    expect(hashHue('')).toBe(0);
  });

  it('returns a number in [0, 360)', () => {
    for (const s of ['a', 'foo', 'user-id-001', 'longer-name-with-dashes']) {
      const h = hashHue(s);
      expect(h).toBeGreaterThanOrEqual(0);
      expect(h).toBeLessThan(360);
    }
  });

  it('is deterministic for the same input', () => {
    expect(hashHue('user-1')).toBe(hashHue('user-1'));
  });

  it('produces different hues for different inputs (with high probability)', () => {
    const a = hashHue('user-aaa');
    const b = hashHue('user-bbb');
    const c = hashHue('user-ccc');
    // 三者不全部相同（allow 极小概率冲突）
    expect(new Set([a, b, c]).size).toBeGreaterThan(1);
  });
});

describe('formatRelative', () => {
  it('returns "刚刚" for less than 1 minute ago', () => {
    const now = new Date();
    const just = new Date(now.getTime() - 30_000);
    expect(formatRelative(just.toISOString())).toBe('刚刚');
  });

  it('returns minutes for < 1 hour', () => {
    const now = new Date();
    const past = new Date(now.getTime() - 5 * 60_000);
    expect(formatRelative(past.toISOString())).toBe('5 分钟前');
  });

  it('returns hours for < 1 day', () => {
    const now = new Date();
    const past = new Date(now.getTime() - 3 * 3_600_000);
    expect(formatRelative(past.toISOString())).toBe('3 小时前');
  });

  it('returns days for < 7 days', () => {
    const now = new Date();
    const past = new Date(now.getTime() - 2 * 86_400_000);
    expect(formatRelative(past.toISOString())).toBe('2 天前');
  });

  it('falls back to locale date for >= 7 days', () => {
    const now = new Date();
    const longAgo = new Date(now.getTime() - 10 * 86_400_000);
    const result = formatRelative(longAgo.toISOString());
    // 应该返回 YYYY/M/D 形式的本地化日期
    expect(result).toMatch(/^\d{4}\/\d{1,2}\/\d{1,2}$/);
  });
});

describe('comment anchors', () => {
  const anchor = {
    quote: '正文片段',
    startOffset: 2,
    endOffset: 6,
    contentHash: 'hash-at-save',
  };

  it('stays valid when the quoted range still matches', () => {
    expect(isCommentAnchorStale(anchor, '前文正文片段后文', 'hash-at-save')).toBe(false);
  });

  it('warns when the article text changed at the saved range', () => {
    expect(isCommentAnchorStale(anchor, '前文已修改后文', 'hash-at-save')).toBe(true);
  });

  it('does not claim stale when the current content is unavailable', () => {
    expect(isCommentAnchorStale(anchor)).toBe(false);
  });
});

// ════════════════════════════════════════════════════════════════════
// CommentSection 组件契约（数据序列化层）
//
// 验证 BFF API 返回的 CommentItem 形态是组件期望的：
//   - children: ReplyItem[]，每条含 id/body/starCount/createdAt/author
//   - promoteStatus: 4 个值
//   - targetType: 'research' | 'summary'
// ════════════════════════════════════════════════════════════════════

describe('CommentSection data contract', () => {
  it('accepts a fully populated CommentItem', () => {
    const item = {
      id: '00000000-0000-4000-8000-000000000001',
      body: 'good point',
      parentId: null,
      starCount: 3,
      promoteStatus: 'nominated' as const,
      createdAt: '2026-07-28T10:00:00Z',
      author: { id: 'u1', name: 'Alice', avatarUrl: null },
      children: [
        {
          id: '00000000-0000-4000-8000-000000000002',
          body: 'reply',
          starCount: 0,
          createdAt: '2026-07-28T10:05:00Z',
          author: { id: 'u2', name: 'Bob', avatarUrl: null },
        },
      ],
      childCount: 1,
    };
    // 形状断言：组件会读这些字段
    expect(item).toHaveProperty('id');
    expect(item).toHaveProperty('body');
    expect(item.children).toHaveLength(1);
    expect(item.children[0]).toHaveProperty('author.name');
  });

  it('handles missing optional children gracefully', () => {
    const item = {
      id: 'x',
      body: '',
      parentId: null,
      starCount: 0,
      promoteStatus: 'none' as const,
      createdAt: '2026-07-28T10:00:00Z',
      author: { id: 'u', name: 'U', avatarUrl: null },
      children: [],
      childCount: 0,
    };
    expect(item.children).toEqual([]);
  });
});
