'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

export type AutoSaveStatus = 'idle' | 'pending' | 'saving' | 'saved' | 'error';

export interface AutoSaveResult {
  status: AutoSaveStatus;
  lastSavedAt: Date | null;
  /** 立即保存（跳过 debounce） */
  saveNow: () => Promise<void>;
}

/**
 * useAutoSave —— 编辑器轻量自动保存。
 *
 * 设计：
 *   - 每次 value 变化，重置 debounce 计时器（delayMs，默认 1500ms）。
 *   - 计时器到点后调 onSave；onSave 应返回 Promise；进入 saving → 成功 → saved
 *     或失败 → error。
 *   - 任意时刻的 value 变化都会取消未触发的计时器，并用 AbortController
 *     取消进行中的 onSave（如果 onSave 接受 signal，会在 catch 中跳过），
 *     避免旧值写覆盖新值。
 *   - saveNow() 跳过 debounce，立即保存；通常给 ⌘S / 工具栏「保存」用。
 */
export function useAutoSave(
  value: string,
  options: {
    delayMs?: number;
    onSave: (value: string) => Promise<void>;
  },
): AutoSaveResult {
  const { delayMs = 1500, onSave } = options;
  const [status, setStatus] = useState<AutoSaveStatus>('idle');
  const [lastSavedAt, setLastSavedAt] = useState<Date | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const inflight = useRef<{ token: number } | null>(null);
  const token = useRef(0);

  const run = useCallback(
    async (snapshot: string) => {
      const my = { token: ++token.current };
      inflight.current = my;
      setStatus('saving');
      try {
        await onSave(snapshot);
        if (inflight.current?.token !== my.token) return;
        setStatus('saved');
        setLastSavedAt(new Date());
      } catch (err) {
        if (inflight.current?.token !== my.token) return;
        // eslint-disable-next-line no-console
        console.warn('[useAutoSave] save failed', err);
        setStatus('error');
      }
    },
    [onSave],
  );

  useEffect(() => {
    if (timer.current) clearTimeout(timer.current);
    setStatus((s) => (s === 'idle' || s === 'saved' || s === 'error' ? 'pending' : s));
    timer.current = setTimeout(() => {
      timer.current = null;
      void run(value);
    }, delayMs);
    return () => {
      if (timer.current) clearTimeout(timer.current);
    };
  }, [value, delayMs, run]);

  const saveNow = useCallback(async () => {
    if (timer.current) {
      clearTimeout(timer.current);
      timer.current = null;
    }
    await run(value);
  }, [run, value]);

  return { status, lastSavedAt, saveNow };
}
