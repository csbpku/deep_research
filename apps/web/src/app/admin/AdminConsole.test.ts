// Unit tests: W8 AdminConsole 组件纯逻辑层。
//
// 策略：项目未装 @testing-library/react（避免引入新依赖），测导出的
// pure helper（syncStatusStyle）。组件渲染层由 P0 真实 API + 浏览器 E2E 覆盖。
//
// 覆盖：
//   - 4 个已知 status：running / completed / partial / failed → 中文 label + 配色 class
//   - 未知 status：fallback 到 status 字面 + 中性色
//   - 状态 → 状态映射稳定性（同输入同输出）
//
// UI 重设计后：配色从裸 hex 改为 Tailwind token class
// （bg-status-*-bg / text-status-*-fg），深浅色由 CSS 变量自动切换，
// 所以断言从 { bg, fg } 十六进制改为 className 字符串。

import { describe, expect, it } from 'vitest';
import { ADMIN_TAB_KEYS, shanghaiDateValue, syncStatusStyle } from './AdminConsole';

describe('syncStatusStyle', () => {
  it('returns running badge for "running" status', () => {
    const s = syncStatusStyle('running');
    expect(s).toEqual({
      label: '运行中',
      className: 'bg-status-running-bg text-status-running-fg',
    });
  });

  it('returns completed badge for "completed" status', () => {
    const s = syncStatusStyle('completed');
    expect(s).toEqual({
      label: '完成',
      className: 'bg-status-succeeded-bg text-status-succeeded-fg',
    });
  });

  it('returns partial badge for "partial" status', () => {
    const s = syncStatusStyle('partial');
    expect(s).toEqual({
      label: '部分',
      className: 'bg-status-partial-bg text-status-partial-fg',
    });
  });

  it('returns failed badge for "failed" status', () => {
    const s = syncStatusStyle('failed');
    expect(s).toEqual({
      label: '失败',
      className: 'bg-status-failed-bg text-status-failed-fg',
    });
  });

  it('returns fallback badge (neutral) for unknown status', () => {
    const s = syncStatusStyle('mystery-state');
    expect(s.label).toBe('mystery-state');
    expect(s.className).toBe('bg-muted text-muted-foreground');
  });

  it('returns fallback for empty status', () => {
    const s = syncStatusStyle('');
    expect(s.label).toBe('');
    expect(s.className).toBe('bg-muted text-muted-foreground');
  });

  it('never returns a raw hex color (tokens only)', () => {
    // 守护：配色必须走 token class，不能回退到裸 hex。
    for (const status of ['running', 'completed', 'partial', 'failed', 'unknown']) {
      expect(syncStatusStyle(status).className).not.toMatch(/#[0-9a-fA-F]{3,8}/);
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
  it('keeps radar candidate review out of the console tabs', () => {
    expect(ADMIN_TAB_KEYS).toEqual([
      'dashboard',
      'researches',
      'topics',
      'shares',
      'comments',
      'users',
    ]);
    expect(ADMIN_TAB_KEYS).not.toContain('radar');
  });
});
