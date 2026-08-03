'use client';

// /researches/import — 从文件导入入口页。
//
// 这个页面 = 一个简短说明 + ImportDialog 默认打开。
// 同时挂载在 /researches/new 的"从文件导入"卡片中（保持单一来源）。

import { useState } from 'react';
import Link from 'next/link';
import { Upload } from 'lucide-react';

import { ImportDialog } from '@/components/ImportDialog';
import { Button } from '@/components/ui/button';

export default function ImportPage() {
  const [dialogOpen, setDialogOpen] = useState(true);

  return (
    <div className="mx-auto max-w-measure">
      <nav className="mb-2 flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
        <Link href="/researches" className="hover:text-foreground hover:underline">
          调研库
        </Link>
        <span>/</span>
        <Link href="/researches/new" className="hover:text-foreground hover:underline">
          新建
        </Link>
        <span>/</span>
        <span>从文件导入</span>
      </nav>

      <h1 className="mb-3 text-xl font-semibold tracking-tight">从文件导入</h1>

      <p className="mb-4 text-sm leading-relaxed text-muted-foreground">
        支持导入 <code className="rounded bg-muted px-1 font-mono text-xs">.md</code> /{' '}
        <code className="rounded bg-muted px-1 font-mono text-xs">.txt</code> /{' '}
        <code className="rounded bg-muted px-1 font-mono text-xs">.html</code> 文件（单文件 ≤ 5MB）。
        系统会清除 HTML 中的危险标签与事件属性，并把内容转换为 Markdown。
        成功后会创建一份个人草稿（不自动发布），可继续编辑。
      </p>

      {!dialogOpen && (
        <Button type="button" onClick={() => setDialogOpen(true)}>
          <Upload />
          选择文件
        </Button>
      )}

      {dialogOpen && <ImportDialog onClose={() => setDialogOpen(false)} />}
    </div>
  );
}
