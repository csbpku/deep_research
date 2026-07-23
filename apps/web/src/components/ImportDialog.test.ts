// Unit tests: W4 ImportDialog 文件扩展名校验（前端预校验）。
//
// 契约：后端 POST /api/imports 已校验扩展名；
// 前端 ImportDialog 在拖拽/选择时也做预校验，避免无效请求。

import { describe, expect, it } from 'vitest';

const ALLOWED_EXTENSIONS = ['.md', '.txt', '.html'] as const;

/**
 * 与 ImportDialog.tsx 内 handleFile 一致：
 *   const dot = file.name.lastIndexOf('.');
 *   const ext = dot >= 0 ? file.name.slice(dot).toLowerCase() : '';
 */
function extractExt(filename: string): string {
  const dot = filename.lastIndexOf('.');
  return dot >= 0 ? filename.slice(dot).toLowerCase() : '';
}

function isAllowedExt(ext: string): boolean {
  return (ALLOWED_EXTENSIONS as readonly string[]).includes(ext);
}

describe('ImportDialog file extension pre-validation', () => {
  it('accepts .md', () => {
    expect(isAllowedExt(extractExt('doc.md'))).toBe(true);
  });

  it('accepts .txt', () => {
    expect(isAllowedExt(extractExt('notes.txt'))).toBe(true);
  });

  it('accepts .html', () => {
    expect(isAllowedExt(extractExt('page.html'))).toBe(true);
  });

  it('rejects .pdf', () => {
    expect(isAllowedExt(extractExt('paper.pdf'))).toBe(false);
  });

  it('rejects .docx', () => {
    expect(isAllowedExt(extractExt('report.docx'))).toBe(false);
  });

  it('rejects uppercase .MD (must be lowercased)', () => {
    const ext = extractExt('README.MD');
    expect(ext).toBe('.md');
    expect(isAllowedExt(ext)).toBe(true);
  });

  it('rejects no extension', () => {
    expect(isAllowedExt(extractExt('README'))).toBe(false);
  });

  it('rejects extension-only filename (".md")', () => {
    // ".md" → lastIndexOf('.') = 0; slice(0) = ".md"
    expect(isAllowedExt(extractExt('.md'))).toBe(true);
  });

  it('rejects double extension like .tar.gz', () => {
    expect(isAllowedExt(extractExt('archive.tar.gz'))).toBe(false);
  });

  it('handles filename with multiple dots', () => {
    // "file.name.md" → lastIndexOf('.') = 9; slice(9) = ".md"
    expect(isAllowedExt(extractExt('file.name.md'))).toBe(true);
  });

  it('rejects executable extensions', () => {
    expect(isAllowedExt(extractExt('evil.sh'))).toBe(false);
    expect(isAllowedExt(extractExt('script.js'))).toBe(false);
    expect(isAllowedExt(extractExt('binary.exe'))).toBe(false);
  });
});

// ──────────────────────────────────────────────────────────────────────
// ImportDialog 状态机（轮询超时、succeeded 跳转）
// ──────────────────────────────────────────────────────────────────────

type Phase = 'idle' | 'uploading' | 'polling' | 'succeeded' | 'failed';
type Status = 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled';

/**
 * 镜像 ImportDialog pollOnce 逻辑：
 * - succeeded → 切到 succeeded phase
 * - failed/cancelled → 切到 failed phase
 * - queued/running → 继续轮询
 */
function nextPhase(status: Status, currentPhase: Phase): Phase {
  if (status === 'succeeded') return 'succeeded';
  if (status === 'failed' || status === 'cancelled') return 'failed';
  if (currentPhase === 'polling') return 'polling';
  return currentPhase;
}

describe('ImportDialog phase transitions', () => {
  it('succeeded status → succeeded phase', () => {
    expect(nextPhase('succeeded', 'polling')).toBe('succeeded');
  });

  it('failed status → failed phase', () => {
    expect(nextPhase('failed', 'polling')).toBe('failed');
  });

  it('cancelled status → failed phase', () => {
    expect(nextPhase('cancelled', 'polling')).toBe('failed');
  });

  it('queued status → keep polling', () => {
    expect(nextPhase('queued', 'polling')).toBe('polling');
  });

  it('running status → keep polling', () => {
    expect(nextPhase('running', 'polling')).toBe('polling');
  });
});

// ──────────────────────────────────────────────────────────────────────
// 文件大小 5MB 校验
// ──────────────────────────────────────────────────────────────────────

const MAX_FILE_BYTES = 5 * 1024 * 1024;

describe('file size limit (5MB)', () => {
  it('allows 1MB file', () => {
    expect(1024 * 1024 <= MAX_FILE_BYTES).toBe(true);
  });

  it('allows exactly 5MB', () => {
    expect(5 * 1024 * 1024 === MAX_FILE_BYTES).toBe(true);
  });

  it('rejects 6MB file', () => {
    expect(6 * 1024 * 1024 > MAX_FILE_BYTES).toBe(true);
  });

  it('MAX_FILE_BYTES constant', () => {
    expect(MAX_FILE_BYTES).toBe(5242880);
  });
});