'use client';

import { useCallback, useEffect, useRef } from 'react';

import { cn } from '@/lib/utils';

interface ReadingProgressBarProps {
  /** 滚动容器的 ref，进度 = scrollTop / (scrollHeight - clientHeight) */
  scrollRef: React.RefObject<HTMLElement | null>;
  className?: string;
}

/**
 * 顶部阅读进度条（1-2px ink-accent）。
 * 监听左栏原文滚动容器，随滚动填满，强化「在读长文」的隐喻。
 */
export function ReadingProgressBar({ scrollRef, className }: ReadingProgressBarProps) {
  const barRef = useRef<HTMLDivElement>(null);

  const update = useCallback(() => {
    const el = scrollRef.current;
    const bar = barRef.current;
    if (!el || !bar) return;
    const max = el.scrollHeight - el.clientHeight;
    const pct = max > 0 ? Math.min(100, (el.scrollTop / max) * 100) : 0;
    bar.style.width = `${pct}%`;
  }, [scrollRef]);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    update();
    el.addEventListener('scroll', update, { passive: true });
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => {
      el.removeEventListener('scroll', update);
      ro.disconnect();
    };
  }, [scrollRef, update]);

  return (
    <div
      ref={barRef}
      className={cn(
        'absolute bottom-[-1px] left-0 h-[2px] bg-[var(--ink-accent)] transition-[width] duration-150 ease-out',
        className,
      )}
      style={{ width: '0%' }}
      aria-hidden
    />
  );
}
