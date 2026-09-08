'use client';

import { useCallback, useEffect, useRef } from 'react';

import { cn } from '@/lib/utils';

interface ReadingProgressBarProps {
  /** 滚动容器的 ref，进度 = scrollTop / (scrollHeight - clientHeight) */
  scrollRef: React.RefObject<HTMLElement | null>;
  className?: string;
}

function findScrollableContainer(element: HTMLElement): HTMLElement | null {
  let current: HTMLElement | null = element;
  while (current) {
    const style = getComputedStyle(current);
    if (
      current.scrollHeight > current.clientHeight + 8
      && (style.overflowY === 'auto' || style.overflowY === 'scroll')
    ) {
      return current;
    }
    current = current.parentElement;
  }
  return null;
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
    const scrollContainer = findScrollableContainer(el);
    const max = scrollContainer
      ? scrollContainer.scrollHeight - scrollContainer.clientHeight
      : document.documentElement.scrollHeight - window.innerHeight;
    const scrollTop = scrollContainer?.scrollTop ?? window.scrollY;
    const pct = max > 0 ? Math.min(100, (scrollTop / max) * 100) : 0;
    bar.style.width = `${pct}%`;
  }, [scrollRef]);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    update();
    const scrollContainers: HTMLElement[] = [];
    let current: HTMLElement | null = el;
    while (current) {
      const style = getComputedStyle(current);
      if (style.overflowY === 'auto' || style.overflowY === 'scroll') {
        scrollContainers.push(current);
      }
      current = current.parentElement;
    }
    scrollContainers.forEach((container) => container.addEventListener('scroll', update, { passive: true }));
    window.addEventListener('scroll', update, { passive: true });
    window.addEventListener('resize', update, { passive: true });
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => {
      scrollContainers.forEach((container) => container.removeEventListener('scroll', update));
      window.removeEventListener('scroll', update);
      window.removeEventListener('resize', update);
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
