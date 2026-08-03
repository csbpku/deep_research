import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

/**
 * 合并 className：clsx 处理条件类，tailwind-merge 消解冲突
 * （例如 `px-2 px-4` → `px-4`，避免 CSS 顺序不确定带来的玄学）。
 */
export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}
