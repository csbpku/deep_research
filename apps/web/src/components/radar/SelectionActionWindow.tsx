'use client';

import React, { useEffect, useRef, useState } from 'react';
import { GripHorizontal } from 'lucide-react';

import { cn } from '@/lib/utils';

interface Position {
  top: number;
  left: number;
}

interface Frame extends Position {
  width: number;
  height: number;
}

interface Props {
  title: string;
  initialPosition: Position;
  placementKey: string;
  onClose: () => void;
  children: React.ReactNode;
  footer?: React.ReactNode;
  className?: string;
}

const MIN_WIDTH = 320;
const MIN_HEIGHT = 220;
const DEFAULT_WIDTH = 500;
const DEFAULT_HEIGHT = 360;
const VIEWPORT_GAP = 12;

function initialFrame(position: Position): Frame {
  if (typeof window === 'undefined') {
    return { ...position, width: DEFAULT_WIDTH, height: DEFAULT_HEIGHT };
  }
  const width = Math.min(DEFAULT_WIDTH, window.innerWidth - VIEWPORT_GAP * 2);
  const height = Math.min(DEFAULT_HEIGHT, window.innerHeight - VIEWPORT_GAP * 2);
  return {
    width,
    height,
    left: Math.min(Math.max(VIEWPORT_GAP, position.left), window.innerWidth - width - VIEWPORT_GAP),
    top: Math.min(Math.max(VIEWPORT_GAP, position.top), window.innerHeight - height - VIEWPORT_GAP),
  };
}

export function SelectionActionWindow({
  title,
  initialPosition,
  placementKey,
  onClose,
  children,
  footer,
  className,
}: Props) {
  const [frame, setFrame] = useState<Frame>(() => initialFrame(initialPosition));
  const interaction = useRef<{
    mode: 'drag' | 'resize';
    startX: number;
    startY: number;
    frame: Frame;
  } | null>(null);
  const moveFrameRef = useRef<number | null>(null);
  const pendingPointerRef = useRef<{ x: number; y: number } | null>(null);

  useEffect(() => {
    setFrame(initialFrame(initialPosition));
  }, [initialPosition.left, initialPosition.top, placementKey]);

  /* Escape 关闭对话框 —— 满足 a11y 规则 #2 (modal-escape) */
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onClose();
      }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  useEffect(() => {
    const move = (event: PointerEvent) => {
      const state = interaction.current;
      if (!state) return;
      pendingPointerRef.current = { x: event.clientX, y: event.clientY };
      if (moveFrameRef.current !== null) return;
      moveFrameRef.current = window.requestAnimationFrame(() => {
        moveFrameRef.current = null;
        const point = pendingPointerRef.current;
        const currentState = interaction.current;
        if (!point || !currentState) return;
        const dx = point.x - currentState.startX;
        const dy = point.y - currentState.startY;
        if (currentState.mode === 'drag') {
          setFrame((current) => ({
            ...current,
            left: Math.min(
              Math.max(VIEWPORT_GAP, currentState.frame.left + dx),
              window.innerWidth - current.width - VIEWPORT_GAP,
            ),
            top: Math.min(
              Math.max(VIEWPORT_GAP, currentState.frame.top + dy),
              window.innerHeight - current.height - VIEWPORT_GAP,
            ),
          }));
          return;
        }
        setFrame((current) => ({
          ...current,
          width: Math.min(
            Math.max(MIN_WIDTH, currentState.frame.width + dx),
            window.innerWidth - currentState.frame.left - VIEWPORT_GAP,
          ),
          height: Math.min(
            Math.max(MIN_HEIGHT, currentState.frame.height + dy),
            window.innerHeight - currentState.frame.top - VIEWPORT_GAP,
          ),
        }));
      });
    };
    const stop = () => {
      if (!interaction.current) return;
      interaction.current = null;
      pendingPointerRef.current = null;
      if (moveFrameRef.current !== null) {
        window.cancelAnimationFrame(moveFrameRef.current);
        moveFrameRef.current = null;
      }
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', stop);
    return () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', stop);
      if (moveFrameRef.current !== null) window.cancelAnimationFrame(moveFrameRef.current);
    };
  }, []);

  const begin = (mode: 'drag' | 'resize', event: React.PointerEvent) => {
    event.preventDefault();
    event.stopPropagation();
    interaction.current = {
      mode,
      startX: event.clientX,
      startY: event.clientY,
      frame,
    };
    document.body.style.cursor = mode === 'drag' ? 'grabbing' : 'nwse-resize';
    document.body.style.userSelect = 'none';
  };

  return (
    <section
      role="dialog"
      aria-modal={false}
      aria-label={title}
      data-selection-ui="true"
      className={cn(
        'fixed z-[9985] flex min-w-0 flex-col overflow-hidden rounded-xl border border-border bg-background shadow-2xl',
        className,
      )}
      style={frame}
      onMouseDown={(event) => event.stopPropagation()}
      onMouseUp={(event) => event.stopPropagation()}
    >
      <header
        className="flex h-11 shrink-0 cursor-grab select-none items-center gap-2 border-b border-border bg-background/95 px-3 backdrop-blur active:cursor-grabbing"
        onPointerDown={(event) => begin('drag', event)}
      >
        <GripHorizontal className="size-4 shrink-0 text-muted-foreground" aria-hidden />
        <h2 className="min-w-0 flex-1 truncate text-xs font-semibold text-foreground">{title}</h2>
        <button
          type="button"
          onPointerDown={(event) => event.stopPropagation()}
          onClick={onClose}
          className="rounded-md px-2 py-1 text-xs text-muted-foreground hover:bg-muted hover:text-foreground"
        >
          关闭
        </button>
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain p-4">{children}</div>
      {footer ? (
        <footer className="flex shrink-0 flex-wrap items-center justify-end gap-1.5 border-t border-border bg-muted/20 px-3 py-2">
          {footer}
        </footer>
      ) : null}
      <button
        type="button"
        aria-label="调整窗口大小"
        title="拖动调整窗口大小"
        onPointerDown={(event) => begin('resize', event)}
        className="absolute bottom-0 right-0 size-5 cursor-nwse-resize after:absolute after:bottom-1 after:right-1 after:size-2.5 after:border-b-2 after:border-r-2 after:border-muted-foreground/45"
      />
    </section>
  );
}
