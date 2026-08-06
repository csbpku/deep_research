// Unit tests: W4 BFF — researches 详情 canEdit / researchSources / sourceComment。
//
// 测试范围：
//   - canEdit 计算：author === u.id || (admin && published)
//   - canEdit 计算：published 给非 author 非 admin → false
//   - canEdit 计算：draft 给非 owner → API 返回 404
//   - type 分支：research 已发布 → 返回 researchSources
//   - type 分支：knowledge → 返回 sourceComment
//   - type 分支：draft → 不挂载 researchSources
//
// 不连真实 DB；纯函数测试 + 类型契约。

import { describe, expect, it } from 'vitest';
import { resolveResearchSourceLink } from '../../../lib/research-source-link';
import { RESEARCH_STATUS, RESEARCH_TYPE } from '@deep-research/shared/states';

// ──────────────────────────────────────────────────────────────────────
// canEdit 计算契约（与 route.ts 内联实现对齐）
// ──────────────────────────────────────────────────────────────────────

interface CanEditArgs {
  authorId: string;
  status: 'draft' | 'published' | 'archived';
  userId: string;
  userRole: 'member' | 'admin';
}

/**
 * Mirror of route.ts GET logic:
 *   - canEdit = authorId === u.id || (admin && status === 'published')
 *   - canManageStatus = authorId === u.id || (admin && status !== 'draft')
 *   - 权限检查：non-published + non-author + non-admin → 404 DRAFT_NOT_FOUND
 */
function canViewAndEdit(r: CanEditArgs): {
  canView: boolean;
  canEdit: boolean;
  canManageStatus: boolean;
} {
  const canView =
    r.status === RESEARCH_STATUS.PUBLISHED ||
    r.authorId === r.userId ||
    r.userRole === 'admin';
  const canEdit =
    r.authorId === r.userId ||
    (r.userRole === 'admin' && r.status === RESEARCH_STATUS.PUBLISHED);
  const canManageStatus =
    r.authorId === r.userId ||
    (r.userRole === 'admin' && r.status !== RESEARCH_STATUS.DRAFT);
  return { canView, canEdit, canManageStatus };
}

describe('canEdit / canView logic for research detail', () => {
  it('owner sees own draft, can edit', () => {
    const r = canViewAndEdit({ authorId: 'A', status: 'draft', userId: 'A', userRole: 'member' });
    expect(r.canView).toBe(true);
    expect(r.canEdit).toBe(true);
    expect(r.canManageStatus).toBe(true);
  });

  it('non-owner cannot view draft (returns 404 DRAFT_NOT_FOUND)', () => {
    const r = canViewAndEdit({ authorId: 'A', status: 'draft', userId: 'B', userRole: 'member' });
    expect(r.canView).toBe(false);
    expect(r.canEdit).toBe(false);
  });

  it('anyone can view published research', () => {
    const r = canViewAndEdit({ authorId: 'A', status: 'published', userId: 'B', userRole: 'member' });
    expect(r.canView).toBe(true);
    expect(r.canEdit).toBe(false);
  });

  it('owner can edit own published research', () => {
    const r = canViewAndEdit({ authorId: 'A', status: 'published', userId: 'A', userRole: 'member' });
    expect(r.canView).toBe(true);
    expect(r.canEdit).toBe(true);
  });

  it('admin can edit another user\'s published research', () => {
    const r = canViewAndEdit({ authorId: 'A', status: 'published', userId: 'B', userRole: 'admin' });
    expect(r.canView).toBe(true);
    expect(r.canEdit).toBe(true);
    expect(r.canManageStatus).toBe(true);
  });

  it('admin can view but cannot edit another user\'s draft', () => {
    const r = canViewAndEdit({ authorId: 'A', status: 'draft', userId: 'B', userRole: 'admin' });
    expect(r.canView).toBe(true);
    expect(r.canEdit).toBe(false);
    expect(r.canManageStatus).toBe(false);
  });

  it('admin can view and restore but cannot edit another user\'s archived research', () => {
    const r = canViewAndEdit({ authorId: 'A', status: 'archived', userId: 'B', userRole: 'admin' });
    expect(r.canView).toBe(true);
    expect(r.canEdit).toBe(false);
    expect(r.canManageStatus).toBe(true);
  });

  it('member cannot edit others published research', () => {
    const r = canViewAndEdit({ authorId: 'A', status: 'published', userId: 'B', userRole: 'member' });
    expect(r.canEdit).toBe(false);
  });
});

// ──────────────────────────────────────────────────────────────────────
// type 分支：research 已发布 → researchSources
// ──────────────────────────────────────────────────────────────────────

describe('research detail type branches', () => {
  it('research type exists', () => {
    expect(RESEARCH_TYPE.RESEARCH).toBe('research');
  });

  it('knowledge type exists', () => {
    expect(RESEARCH_TYPE.KNOWLEDGE).toBe('knowledge');
  });

  /**
   * 模拟 route.ts 内的分支：
   * - published + type='research' → 返回 researchSources
   * - 其他（draft/archived 或 type='knowledge'）→ researchSources 空数组
   */
  function shouldIncludeSources(status: string, type: string): boolean {
    return status === RESEARCH_STATUS.PUBLISHED && type === RESEARCH_TYPE.RESEARCH;
  }

  it('published long research includes sources', () => {
    expect(shouldIncludeSources('published', 'research')).toBe(true);
  });

  it('published knowledge does NOT include sources (uses sourceComment instead)', () => {
    expect(shouldIncludeSources('published', 'knowledge')).toBe(false);
  });

  it('draft research does NOT include sources', () => {
    expect(shouldIncludeSources('draft', 'research')).toBe(false);
  });

  it('archived research does NOT include sources', () => {
    expect(shouldIncludeSources('archived', 'research')).toBe(false);
  });
});

// ──────────────────────────────────────────────────────────────────────
// type 分支：knowledge → sourceComment
// ──────────────────────────────────────────────────────────────────────

describe('sourceComment handling', () => {
  /**
   * knowledge 类型的 research 应有 sourceCommentId 非空；
   * 详情 API 根据 sourceCommentId 拉取评论 + 目标 summary/research。
   */
  function hasSourceComment(type: string, sourceCommentId: string | null): boolean {
    return type === RESEARCH_TYPE.KNOWLEDGE && sourceCommentId !== null;
  }

  it('knowledge with sourceCommentId → has sourceComment', () => {
    expect(hasSourceComment('knowledge', 'cmt-1')).toBe(true);
  });

  it('research without sourceCommentId → no sourceComment', () => {
    expect(hasSourceComment('research', null)).toBe(false);
  });

  it('knowledge without sourceCommentId (data integrity issue) → false', () => {
    expect(hasSourceComment('knowledge', null)).toBe(false);
  });
});

// ──────────────────────────────────────────────────────────────────────
// sourceRef 解析为 href 的契约（前端 detail page 用）
// ──────────────────────────────────────────────────────────────────────

describe('sourceRef → href resolution', () => {
  it('url → returns url as-is', () => {
    expect(resolveResearchSourceLink({ type: 'url', value: 'https://example.com/a' })?.href)
      .toBe('https://example.com/a');
  });

  it('doi → doi.org link', () => {
    expect(resolveResearchSourceLink({ type: 'doi', value: '10.1234/abc' })?.href)
      .toBe('https://doi.org/10.1234/abc');
  });

  it('arxiv → arxiv.org/abs link', () => {
    expect(resolveResearchSourceLink({ type: 'arxiv', value: '2501.12345' })?.href)
      .toBe('https://arxiv.org/abs/2501.12345');
  });

  it('unknown type → null', () => {
    expect(resolveResearchSourceLink({ type: 'book', value: 'xxx' })).toBe(null);
  });

  it('missing value → null', () => {
    expect(resolveResearchSourceLink({ type: 'url' })).toBe(null);
  });
});
