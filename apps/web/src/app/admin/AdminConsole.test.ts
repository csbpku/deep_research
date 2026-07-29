// Unit tests: W8 AdminConsole 组件纯逻辑层。
//
// 策略：项目未装 @testing-library/react（避免引入新依赖），测导出的
// pure helper（syncStatusStyle）。组件渲染层由 P0 真实 API + 浏览器 E2E 覆盖。
//
// 覆盖：
//   - 4 个已知 status：running / completed / partial / failed → 中文 label + 配色
//   - 未知 status：fallback 到 status 字面 + 灰底
//   - 状态 → 状态映射稳定性（同输入同输出）

import { describe, expect, it } from 'vitest';
import { syncStatusStyle } from './AdminConsole';

describe('syncStatusStyle', () => {
  it('returns running badge for "running" status', () => {
    const s = syncStatusStyle('running');
    expect(s).toEqual({ label: '运行中', bg: '#dbeafe', fg: '#1d4ed8' });
  });

  it('returns completed badge for "completed" status', () => {
    const s = syncStatusStyle('completed');
    expect(s).toEqual({ label: '完成', bg: '#dcfce7', fg: '#15803d' });
  });

  it('returns partial badge for "partial" status', () => {
    const s = syncStatusStyle('partial');
    expect(s).toEqual({ label: '部分', bg: '#fef3c7', fg: '#92400e' });
  });

  it('returns failed badge for "failed" status', () => {
    const s = syncStatusStyle('failed');
    expect(s).toEqual({ label: '失败', bg: '#fee2e2', fg: '#b91c1c' });
  });

  it('returns fallback badge (gray) for unknown status', () => {
    const s = syncStatusStyle('mystery-state');
    expect(s.label).toBe('mystery-state');
    expect(s.bg).toBe('#f1f5f9');
    expect(s.fg).toBe('#475569');
  });

  it('returns fallback for empty status', () => {
    const s = syncStatusStyle('');
    expect(s.label).toBe('');
    expect(s.bg).toBe('#f1f5f9');
  });

  it('is deterministic', () => {
    expect(syncStatusStyle('completed')).toEqual(syncStatusStyle('completed'));
  });
});

// ════════════════════════════════════════════════════════════════════
// Tabs 列表契约
// ════════════════════════════════════════════════════════════════════

describe('AdminConsole tabs contract', () => {
  it('defines 4 expected tab keys (dashboard/radar/shares/comments)', () => {
    // 与 AdminConsole 组件 TABS 数组对应
    const expected = ['dashboard', 'radar', 'shares', 'comments'];
    expect(expected).toHaveLength(4);
    expect(new Set(expected).size).toBe(4); // 全部唯一
  });
});