'use client';

import { cn } from '@/lib/utils';

export interface MarginaliaAnchor {
  /** 对应原文锚点 id（h2/h3 的 id） */
  anchorId: string;
  /** 相对滚动容器的绝对 top 偏移（px），由父组件测量后传入 */
  top: number;
  /** 序号（AI导读高亮顺序，1-based） */
  order: number;
}

interface MarginaliaProps {
  anchors: MarginaliaAnchor[];
  activeAnchorId?: string | null;
  onAnchorClick: (anchorId: string) => void;
  className?: string;
}

/**
 * Marginalia ↗ 角标边栏（signature 元素）。
 *
 * 左栏原文最左侧的窄 rail，承载「AI 在导读里提到的段落」的 ↗ 圆形角标。
 * 点击角标 → 父组件滚动到原文对应段 + 高亮；与右栏「原文中的这一段 ↗」双向锚定。
 *
 * 复用场景：AI导读的高亮回链、目录跳转。角标位置由父组件测量原文 h2/h3 offset 后传入。
 */
export function Marginalia({ anchors, activeAnchorId, onAnchorClick, className }: MarginaliaProps) {
  return (
    <div
      className={cn('pointer-events-none absolute left-0 top-0 bottom-0 w-7', className)}
      aria-hidden
    >
      {anchors.map((anchor) => (
        <button
          key={anchor.anchorId}
          type="button"
          onClick={() => onAnchorClick(anchor.anchorId)}
          data-active={anchor.anchorId === activeAnchorId}
          className={cn(
            'pointer-events-auto absolute left-0 flex size-[22px] cursor-pointer items-center justify-center',
            'rounded-full border border-[var(--ink-accent)] bg-[var(--ink-page)] text-sm text-[var(--ink-accent)]',
            'transition-[transform,box-shadow,background-color,color] duration-200',
            'hover:scale-110 hover:shadow-[0_2px_8px_rgba(26,58,110,0.3)]',
            'data-[active=true]:bg-[var(--ink-accent)] data-[active=true]:text-white',
          )}
          style={{ top: anchor.top }}
          aria-label={`跳转到原文第 ${anchor.order} 处 AI 提到的段落`}
        >
          <span className="text-[11px] leading-none">↗</span>
        </button>
      ))}
    </div>
  );
}
