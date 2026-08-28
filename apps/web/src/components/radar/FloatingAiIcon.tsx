'use client';

import { Sparkles } from 'lucide-react';

import { cn } from '@/lib/utils';

interface FloatingAiIconProps {
  /** Sheet 是否打开（打开时隐藏，避免遮挡面板内容） */
  isOpen: boolean;
  /** 未读消息数（>0 显示红点） */
  unreadCount?: number;
  onClick: () => void;
  className?: string;
}

/**
 * 右下角「AI 讨论 ✨」浮窗 pill。
 * Folo 风格的浮动操作按钮：文字 + 图标，比纯圆 FAB 更有产品感。
 */
export function FloatingAiIcon({ isOpen, unreadCount = 0, onClick, className }: FloatingAiIconProps) {
  if (isOpen) return null;

  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        /* 触控目标 ≥ 44×44 (h-11 + 充裕 padding)，既保持 Folo 风也满足移动端可达 */
        'fixed bottom-6 right-6 z-[9999] flex h-11 min-w-[44px] cursor-pointer items-center gap-2 rounded-[22px] px-[18px] pl-[14px]',
        'bg-[var(--ink-accent)] font-sans text-[13px] font-semibold text-white shadow-[0_2px_10px_rgba(26,58,110,0.18)]',
        'transition-[transform,box-shadow,opacity] duration-200',
        'hover:scale-[1.03] hover:shadow-[0_4px_16px_rgba(26,58,110,0.26)]',
        'active:scale-[0.98]',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background',
        className,
      )}
      aria-label={unreadCount > 0 ? `与 AI 讨论（${unreadCount} 条未读）` : '与 AI 讨论'}
    >
      <Sparkles className="size-4" aria-hidden />
      <span>AI 讨论</span>
      {unreadCount > 0 ? (
        <span
          className="size-2 rounded-full bg-status-failed-fg"
          aria-hidden
        />
      ) : null}
    </button>
  );
}
