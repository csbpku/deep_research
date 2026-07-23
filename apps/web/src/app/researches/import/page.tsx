'use client';

// /researches/import — 从文件导入入口页。
//
// 这个页面 = 一个简短说明 + ImportDialog 默认打开。
// 同时挂载在 /researches/new 的"从文件导入"卡片中（保持单一来源）。

import { useState } from 'react';
import Link from 'next/link';
import { ImportDialog } from '@/components/ImportDialog';

export default function ImportPage() {
  const [dialogOpen, setDialogOpen] = useState(true);

  return (
    <div>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 8 }}>
        <Link href="/researches" style={{ fontSize: 13, color: '#64748b', textDecoration: 'none' }}>
          沉淀
        </Link>
        <span style={{ color: '#94a3b8' }}>/</span>
        <Link href="/researches/new" style={{ fontSize: 13, color: '#64748b', textDecoration: 'none' }}>
          新建
        </Link>
        <span style={{ color: '#94a3b8' }}>/</span>
        <span style={{ fontSize: 13, color: '#475569' }}>从文件导入</span>
      </div>

      <h1 style={{ fontSize: 22, margin: '0 0 16px' }}>从文件导入</h1>

      <p style={{ fontSize: 14, color: '#475569', margin: '0 0 16px', lineHeight: 1.7 }}>
        支持导入 <code>.md</code> / <code>.txt</code> / <code>.html</code> 文件（单文件 ≤ 5MB）。
        系统会清除 HTML 中的危险标签与事件属性，并把内容转换为 Markdown。
        成功后会创建一份个人草稿（不自动发布），可继续编辑。
      </p>

      {!dialogOpen && (
        <button
          onClick={() => setDialogOpen(true)}
          style={{
            padding: '10px 20px',
            border: 'none',
            borderRadius: 6,
            background: '#0f172a',
            color: '#fff',
            cursor: 'pointer',
            fontSize: 14,
          }}
        >
          选择文件
        </button>
      )}

      {dialogOpen && <ImportDialog onClose={() => setDialogOpen(false)} />}
    </div>
  );
}