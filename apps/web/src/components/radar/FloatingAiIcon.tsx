'use client';

import { Sparkles } from 'lucide-react';

import { cn } from '@/lib/utils';

interface FloatingAiIconProps {
  /** Sheet 是否打开（打开时缩小半透明，不消失） */
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
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'fixed bottom-6 right-6 z-[9999] flex h-10 cursor-pointer items-center gap-2 rounded-[20px] px-[18px] pl-[14px]',
        'bg-[var(--ink-accent)] font-sans text-[13px] font-semibold text-white shadow-[0_6px_20px_rgba(0,0,0,0.25)]',
        'transition-[transform,box-shadow,opacity] duration-200',
        'hover:scale-105 hover:shadow-[0_8px_28px_rgba(0,0,0,0.3)]',
        'active:scale-[0.98]',
        isOpen && 'scale-[0.85] opacity-40 hover:scale-[0.95] hover:opacity-100',
        className,
      )}
      aria-label="与 AI 讨论"
    >
      <Sparkles className="size-4" aria-hidden />
      <span>AI 讨论</span>
      {unreadCount > 0 ? (
        <span className="size-2 rounded-full bg-[#E74C3C]" aria-label={`${unreadCount} 条未读`} />
      ) : null}
    </button>
  );
}
