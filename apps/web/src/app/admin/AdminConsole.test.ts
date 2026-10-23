// Unit tests: W8 AdminConsole 组件纯逻辑层。
//
// 策略：项目未装 @testing-library/react（避免引入新依赖），测导出的
// pure helper（syncStatusStyle）。组件渲染层由 P0 真实 API + 浏览器 E2E 覆盖。
//
// 覆盖：
//   - 4 个已知 status：running / completed / partial / failed → 中文 label + MUI sx 配色
//   - 未知 status：fallback 到 status 字面 + 中性色
//   - 状态 → 状态映射稳定性（同输入同输出）
//
// 状态配色统一来自共享设计 token，不依赖 Tailwind 类。

import { describe, expect, it } from 'vitest';
import { ADMIN_TAB_KEYS, shanghaiDateValue, syncStatusStyle } from './AdminConsole';

describe('syncStatusStyle', () => {
  it('returns running badge for "running" status', () => {
    const s = syncStatusStyle('running');
    expect(s).toEqual({
      label: '运行中',
      sx: { backgroundColor: 'var(--dr-color-primary-container)', color: 'primary.main' },
    });
  });

  it('returns completed badge for "completed" status', () => {
    const s = syncStatusStyle('completed');
    expect(s).toEqual({
      label: '完成',
      sx: { backgroundColor: 'var(--dr-color-success-container)', color: 'success.main' },
    });
  });

  it('returns partial badge for "partial" status', () => {
    const s = syncStatusStyle('partial');
    expect(s).toEqual({
      label: '部分',
      sx: { backgroundColor: 'var(--dr-color-warning-container)', color: 'warning.main' },
    });
  });

  it('returns failed badge for "failed" status', () => {
    const s = syncStatusStyle('failed');
    expect(s).toEqual({
      label: '失败',
      sx: { backgroundColor: 'var(--dr-color-danger-container)', color: 'error.main' },
    });
  });

  it('returns fallback badge (neutral) for unknown status', () => {
    const s = syncStatusStyle('mystery-state');
    expect(s.label).toBe('mystery-state');
    expect(s.sx).toEqual({ backgroundColor: 'action.hover', color: 'text.secondary' });
  });

  it('returns fallback for empty status', () => {
    const s = syncStatusStyle('');
    expect(s.label).toBe('');
    expect(s.sx).toEqual({ backgroundColor: 'action.hover', color: 'text.secondary' });
  });

  it('never returns a raw hex color (tokens only)', () => {
    // 守护：配色必须走 token class，不能回退到裸 hex。
    for (const status of ['running', 'completed', 'partial', 'failed', 'unknown']) {
      expect(JSON.stringify(syncStatusStyle(status).sx)).not.toMatch(/#[0-9a-fA-F]{3,8}/);
    }
  });

  it('is deterministic', () => {
    expect(syncStatusStyle('completed')).toEqual(syncStatusStyle('completed'));
  });
});

describe('shanghaiDateValue', () => {
  it('uses the Asia/Shanghai calendar date around UTC midnight', () => {
    expect(shanghaiDateValue(new Date('2026-08-05T16:30:00.000Z'))).toBe('2026-08-06');
  });
});

// ════════════════════════════════════════════════════════════════════
// Tabs 列表契约
// ════════════════════════════════════════════════════════════════════

describe('AdminConsole tabs contract', () => {
  it('includes the radar governance tab', () => {
    expect(ADMIN_TAB_KEYS).toEqual([
      'dashboard',
      'radar',
      'researches',
      'topics',
      'shares',
      'comments',
      'llm_usage',
      'users',
    ]);
  });
});
