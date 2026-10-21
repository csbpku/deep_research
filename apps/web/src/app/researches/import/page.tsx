'use client';

// /researches/import — 从文件导入入口页。
//
// 这个页面 = 一段简短说明 + ImportDialog 默认打开。
// 同时挂载在 /researches/new 的“从文件导入”入口中（保持单一来源）。

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { Upload } from 'lucide-react';
import Box from '@mui/material/Box';
import Breadcrumbs from '@mui/material/Breadcrumbs';
import Button from '@mui/material/Button';
import MaterialLink from '@mui/material/Link';
import Typography from '@mui/material/Typography';

import { ImportDialog } from '@/components/ImportDialog';
import { PageHeader } from '@/components/domain/PageHeader';

export default function ImportPage() {
  // 延迟到首帧 paint 之后再打开 Dialog,避免页面 description 还没渲染就被遮罩盖住。
  // SSR 时不打开(避免 hydration mismatch),客户端 mount 后 microtask 内打开。
  const [dialogOpen, setDialogOpen] = useState(false);
  useEffect(() => {
    Promise.resolve().then(() => setDialogOpen(true));
  }, []);

  return (
    <Box sx={{ width: '100%', maxWidth: 'var(--dr-width-reading)', mx: 'auto' }}>
      <Breadcrumbs aria-label="面包屑" sx={{ mb: 1 }}>
        <MaterialLink component={Link} href="/researches" underline="hover" color="text.secondary" variant="metadata">
          研究库
        </MaterialLink>
        <MaterialLink component={Link} href="/researches/new" underline="hover" color="text.secondary" variant="metadata">
          新建
        </MaterialLink>
        <Typography color="text.primary" variant="metadata">从文件导入</Typography>
      </Breadcrumbs>

      <PageHeader
        variant="workbench"
        title="从文件导入"
        description="支持 .md / .txt / .html 文件（单文件 ≤ 5MB）。系统会清除 HTML 中的危险标签与事件属性，并把内容转换为 Markdown。成功后会创建一份个人草稿（不自动发布），可继续编辑。"
      />

      {!dialogOpen ? (
        <Button type="button" onClick={() => setDialogOpen(true)} startIcon={<Upload size={16} />}>
          选择文件
        </Button>
      ) : null}

      {dialogOpen ? <ImportDialog onClose={() => setDialogOpen(false)} /> : null}
    </Box>
  );
}
