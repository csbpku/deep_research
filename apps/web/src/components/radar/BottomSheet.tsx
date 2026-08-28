'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { GripVertical, Minus, X } from 'lucide-react';
import { cn } from '@/lib/utils';

type SheetState = 'closed' | 'open' | 'minimized';

type ResizeMode = 'top' | 'left' | 'corner' | null;

interface BottomSheetProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** 标题（如「与 AI 讨论」） */
  title: string;
  /** 副标题（如模型名） */
  subtitle?: string;
  /** 右侧内容（chat 主体，M3/M7 接入） */
  children: React.ReactNode;
  /** 底部输入区（M3/M7 接入） */
  footer?: React.ReactNode;
  className?: string;
}

const MIN_WIDTH = 280;
const MIN_HEIGHT = 200;
const DEFAULT_WIDTH = 'min(420px, calc(100vw - 24px))';
const DEFAULT_HEIGHT = '82vh';

/**
 * 右下角浮窗 Sheet —— 可拖动（吸附顶/底）、可缩放（顶/左/角手柄）、可最小化。
 *
 * 状态机：
 *   closed →(pill)→ open →(×)→ closed
 *   open →(▾)→ minimized →(标签条)→ open
 *   open →(header 拖动)→ 吸附 top（全屏）| bottom（默认右下角）
 *
 * 复用场景：与 AI 讨论（M7 接入 chat），未来可复用于其他浮窗面板。
 */
export function BottomSheet({
  open,
  onOpenChange,
  title,
  subtitle,
  children,
  footer,
  className,
}: BottomSheetProps) {
  const [minimized, setMinimized] = useState(false);
  const sheetRef = useRef<HTMLDivElement>(null);
  const restoredSize = useRef({ width: DEFAULT_WIDTH, height: DEFAULT_HEIGHT });
  const dragState = useRef<{
    mode: 'drag' | ResizeMode;
    startX: number;
    startY: number;
    startRight: number;
    startBottom: number;
    startW: number;
    startH: number;
  } | null>(null);
  const [snappedTop, setSnappedTop] = useState(false);

  const close = useCallback(() => {
    setMinimized(false);
    setSnappedTop(false);
    onOpenChange(false);
  }, [onOpenChange]);

  const minimize = useCallback(() => {
    // The minimized state is represented by the persistent floating trigger,
    // not by a narrow vertical strip attached to the right edge.
    setMinimized(false);
    setSnappedTop(false);
    onOpenChange(false);
  }, [onOpenChange]);

  const restore = useCallback(() => {
    const el = sheetRef.current;
    if (el) {
      el.style.width = restoredSize.current.width;
      el.style.height = restoredSize.current.height;
    }
    setMinimized(false);
  }, []);

  // 打开时重置尺寸/位置
  useEffect(() => {
    if (open) {
      setMinimized(false);
      setSnappedTop(false);
      const el = sheetRef.current;
      if (el) {
        el.style.width = DEFAULT_WIDTH;
        el.style.height = DEFAULT_HEIGHT;
        el.style.top = 'auto';
        el.style.bottom = '0';
        el.style.right = '0';
        el.style.left = 'auto';
      }
    }
  }, [open]);

  const isInHeader = useCallback((target: EventTarget | null) => {
    const header = sheetRef.current?.querySelector('[data-sheet-header]');
    if (!header || !(target instanceof Node)) return false;
    if (target === header) return true;
    if (header.contains(target)) {
      const el = target as HTMLElement;
      const tag = el.tagName;
      if (tag === 'BUTTON' || tag === 'TEXTAREA' || tag === 'INPUT' || tag === 'A') return false;
      return true;
    }
    return false;
  }, []);

  const onMouseDown = useCallback(
    (e: React.MouseEvent) => {
      if (!open) return;
      const el = sheetRef.current;
      if (!el) return;

      // 缩放手柄优先于拖动
      const handle = (e.target as HTMLElement).dataset?.resize as ResizeMode | undefined;
      const target = e.target as HTMLElement;
      let mode: 'drag' | ResizeMode;
      if (handle === 'top' || handle === 'left' || handle === 'corner') {
        mode = handle;
      } else if (isInHeader(e.target)) {
        mode = 'drag';
      } else {
        return;
      }

      e.preventDefault();
      const rect = el.getBoundingClientRect();
      dragState.current = {
        mode,
        startX: e.clientX,
        startY: e.clientY,
        startRight: window.innerWidth - rect.right,
        startBottom: window.innerHeight - rect.bottom,
        startW: rect.width,
        startH: rect.height,
      };
      el.style.transition = 'none';
      if (mode === 'drag') el.dataset.dragging = 'true';
    },
    [open, isInHeader],
  );

  useEffect(() => {
    const onMove = (e: MouseEvent) => {
      const st = dragState.current;
      const el = sheetRef.current;
      if (!st || !el) return;

      if (st.mode === 'drag') {
        const newRight = Math.max(0, st.startRight - (e.clientX - st.startX));
        const newBottom = Math.max(0, st.startBottom - (e.clientY - st.startY));
        el.style.right = `${newRight}px`;
        el.style.bottom = `${newBottom}px`;
      } else if (st.mode === 'top') {
        const newH = Math.max(MIN_HEIGHT, st.startH + (st.startY - e.clientY));
        el.style.height = `${newH}px`;
      } else if (st.mode === 'left') {
        const newW = Math.max(MIN_WIDTH, st.startW + (st.startX - e.clientX));
        el.style.width = `${newW}px`;
      } else if (st.mode === 'corner') {
        const newW = Math.max(MIN_WIDTH, st.startW + (st.startX - e.clientX));
        const newH = Math.max(MIN_HEIGHT, st.startH + (st.startY - e.clientY));
        el.style.width = `${newW}px`;
        el.style.height = `${newH}px`;
      }
    };

    const onUp = (e: MouseEvent) => {
      const st = dragState.current;
      const el = sheetRef.current;
      if (!st || !el) return;

      el.style.transition = '';
      if (st.mode === 'drag') {
        el.dataset.dragging = undefined;
        if (e.clientY < 80) {
          setSnappedTop(true);
          el.style.bottom = 'auto';
          el.style.top = '50px';
          el.style.right = '0';
          el.style.left = '0';
        } else if (e.clientY > window.innerHeight - 80) {
          setSnappedTop(false);
          el.style.top = 'auto';
          el.style.bottom = '0';
          el.style.right = '0';
          el.style.left = 'auto';
        }
      }
      dragState.current = null;
    };

    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
    return () => {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
    };
  }, []);

  /* Escape 关闭面板 —— 满足 a11y 规则 (modal-escape) */
  useEffect(() => {
    if (!open) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onOpenChange(false);
      }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onOpenChange]);

  if (!open) return null;

  return (
    <div
      ref={sheetRef}
      onMouseDown={onMouseDown}
      role="dialog"
      aria-modal={false}
      className={cn(
        'fixed bottom-0 right-0 z-[9990] flex flex-col',
        'w-[42%] bg-[var(--ink-paper)] shadow-[0_-8px_24px_rgba(0,0,0,0.15)]',
        'rounded-tl-[16px]',
        'animate-[sheet-slide-up_0.3s_ease-out]',
        snappedTop && 'top-[50px] bottom-auto h-[calc(100vh-50px)]',
        minimized && 'w-10',
        className,
      )}
      style={{ height: DEFAULT_HEIGHT, borderRadius: '16px 0 0 0' }}
      data-minimized={minimized || undefined}
      data-dragging={undefined}
    >
      {/* 缩放手柄 */}
      <div
        data-resize="top"
        className="absolute top-[-7px] left-4 right-4 z-10 flex h-4 cursor-ns-resize items-start justify-center before:mt-1 before:h-1 before:w-12 before:rounded-full before:bg-[var(--ink-faint)]/60 hover:before:bg-[var(--ink-accent)]"
        title="拖动调整高度"
      />
      <div
        data-resize="left"
        className="absolute left-[-7px] top-4 bottom-4 z-10 w-4 cursor-ew-resize before:absolute before:left-1/2 before:top-1/2 before:h-12 before:w-1 before:-translate-x-1/2 before:-translate-y-1/2 before:rounded-full before:bg-[var(--ink-faint)]/60 hover:before:bg-[var(--ink-accent)]"
        title="拖动调整宽度"
      />
      <div
        data-resize="corner"
        className="absolute top-[-7px] left-[-7px] z-10 size-6 cursor-nwse-resize before:absolute before:left-1/2 before:top-1/2 before:size-2 before:-translate-x-1/2 before:-translate-y-1/2 before:rounded-full before:bg-[var(--ink-faint)]/70 hover:before:bg-[var(--ink-accent)]"
        title="拖动调整宽高"
      />

      {minimized ? (
        <button
          type="button"
          onClick={restore}
          className="flex flex-1 flex-col items-center justify-center gap-3 font-sans text-xs font-semibold text-[var(--ink-accent)]"
        >
          <span className="[writing-mode:vertical-rl] tracking-[0.08em]">{title}</span>
        </button>
      ) : (
        <>
          <header
            data-sheet-header
            className="flex cursor-grab select-none items-center gap-2.5 rounded-tl-[16px] border-b border-[var(--ink-rule)] bg-white px-5 py-3.5"
          >
            <GripVertical className="size-4 shrink-0 cursor-grab select-none text-[var(--ink-faint)]" aria-hidden />
            <h2 className="flex-1 font-sans text-[15px] font-semibold">{title}</h2>
            {subtitle ? (
              <span className="hidden max-w-[28%] truncate font-sans text-xs text-[var(--ink-muted)] sm:inline">{subtitle}</span>
            ) : null}
            <button
              type="button"
              onClick={minimize}
              className="rounded-md p-1.5 text-[var(--ink-muted)] hover:bg-[var(--ink-paper)] hover:text-[var(--ink-text)]"
              aria-label="最小化"
            >
              <Minus className="size-4" />
            </button>
            <button
              type="button"
              onClick={close}
              className="rounded-md p-1.5 text-[var(--ink-muted)] hover:bg-[var(--ink-paper)] hover:text-[var(--ink-text)]"
              aria-label="关闭"
            >
              <X className="size-4" />
            </button>
          </header>

          <div className="flex min-h-0 flex-1 overflow-hidden">{children}</div>

          {footer ? (
            <div className="flex flex-shrink-0 gap-2 border-t border-[var(--ink-rule)] bg-white px-6 py-3">
              {footer}
            </div>
          ) : null}
        </>
      )}
    </div>
  );
}
