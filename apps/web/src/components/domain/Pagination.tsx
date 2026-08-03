'use client';

import * as React from 'react';
import { ChevronLeft, ChevronRight } from 'lucide-react';

import { Button } from '@/components/ui/button';

/**
 * Pagination —— 列表页翻页。
 * 迁移前 radar/page.tsx 与 researches/page.tsx 各内联写了一份。
 *
 * ⚠️ e2e 契约：外层 <nav aria-label="分页"> 必须保留。
 * 文案「上一页」「下一页」「第 N / M 页」也一并保留，避免正文正则断言失效。
 */
export function Pagination({
  page,
  totalPages,
  onPageChange,
  disabled = false,
}: {
  page: number;
  totalPages: number;
  onPageChange: (next: number) => void;
  /** 请求进行中时禁用，避免连点 */
  disabled?: boolean;
}) {
  if (totalPages <= 1) return null;

  return (
    <nav aria-label="分页" className="flex items-center justify-center gap-3 py-4">
      <Button
        type="button"
        variant="outline"
        size="sm"
        disabled={page <= 1 || disabled}
        onClick={() => onPageChange(Math.max(1, page - 1))}
      >
        <ChevronLeft />
        上一页
      </Button>
      <span className="font-mono text-xs text-muted-foreground">
        第 {page} / {totalPages} 页
      </span>
      <Button
        type="button"
        variant="outline"
        size="sm"
        disabled={page >= totalPages || disabled}
        onClick={() => onPageChange(Math.min(totalPages, page + 1))}
      >
        下一页
        <ChevronRight />
      </Button>
    </nav>
  );
}
