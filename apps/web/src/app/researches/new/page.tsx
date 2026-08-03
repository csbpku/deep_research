'use client';

// /researches/new — 新建调研入口（属于「调研库」的子页面）。
//
// 标题用「新建调研」而不是「新建调研库」——
// 用户来这里是要写一篇研究，不是要建一座图书馆。
//
// 提供两个入口卡片：
//   1. "从空白创建" → 表单（标题 + 正文 + 结构化字段 + 标签）
//   2. "从文件导入" → /researches/import（弹窗 + 转换 + Markdown 预览）

import { useState, useCallback } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useQueryClient } from '@tanstack/react-query';
import { FilePlus2, Upload } from 'lucide-react';

import { TagChip, TagList } from '@/components/domain/TagChip';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';

export default function NewResearchPage() {
  const router = useRouter();
  const queryClient = useQueryClient();

  const [mode, setMode] = useState<'pick' | 'create'>('pick');
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [background, setBackground] = useState('');
  const [conclusion, setConclusion] = useState('');
  const [risks, setRisks] = useState('');
  const [tagsInput, setTagsInput] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  const tags = tagsInput
    .split(',')
    .map((t) => t.trim())
    .filter(Boolean);

  const handleSave = useCallback(async () => {
    setError('');
    setSaving(true);
    try {
      const payload = {
        title: title || '未命名调研库',
        body: body || '# 开始编写...',
        background: background || null,
        conclusion: conclusion || null,
        risks: risks || null,
        tags,
      };
      const res = await fetch('/api/researches', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
      });
      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.message ?? '保存失败');
      }
      const data = await res.json();
      queryClient.invalidateQueries({ queryKey: ['researches'] });
      router.push(`/researches/${data.id}/edit`);
    } catch (e) {
      setError(e instanceof Error ? e.message : '保存失败');
    } finally {
      setSaving(false);
    }
  }, [title, body, background, conclusion, risks, tags, router, queryClient]);

  if (mode === 'pick') {
    return (
      <div className="mx-auto max-w-measure">
        <nav className="mb-2 flex items-center gap-1.5 text-xs text-muted-foreground">
          <Link href="/researches" className="hover:text-foreground hover:underline">
            调研库
          </Link>
          <span>/</span>
          <span>新建</span>
        </nav>
        <h1 className="mb-4 text-xl font-semibold tracking-tight">新建调研</h1>

        <div className="grid gap-3 sm:grid-cols-2">
          <button
            type="button"
            onClick={() => setMode('create')}
            className="cursor-pointer rounded-lg border border-border bg-card p-5 text-left transition-colors duration-200 hover:border-primary/40 hover:bg-accent/30 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <div className="flex items-center gap-2">
              <FilePlus2 className="size-4 text-primary" />
              <span className="text-sm font-semibold">从空白创建</span>
            </div>
            <p className="mt-2 text-sm text-muted-foreground">
              直接写标题 + 正文 + 背景 / 结论 / 风险 / 标签
            </p>
          </button>

          <Link
            href="/researches/import"
            className="block rounded-lg border border-border bg-card p-5 transition-colors duration-200 hover:border-primary/40 hover:bg-accent/30 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <div className="flex items-center gap-2">
              <Upload className="size-4 text-primary" />
              <span className="text-sm font-semibold">从文件导入</span>
            </div>
            <p className="mt-2 text-sm text-muted-foreground">
              拖拽 .md / .txt / .html（≤ 5MB）→ 自动转 Markdown → 个人草稿
            </p>
          </Link>
        </div>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-measure">
      <div className="mb-4 flex items-center justify-between gap-2">
        <h1 className="text-xl font-semibold tracking-tight">新建调研</h1>
        <Button type="button" variant="outline" size="sm" onClick={() => setMode('pick')}>
          返回
        </Button>
      </div>

      {error && (
        <div
          role="alert"
          className="mb-3 rounded-md border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive"
        >
          {error}
        </div>
      )}

      <div className="space-y-3">
        <div className="grid gap-1.5">
          <label htmlFor="new-title" className="text-sm font-medium">
            标题
          </label>
          <Input
            id="new-title"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="输入标题…"
          />
        </div>

        <div className="grid gap-1.5">
          <label htmlFor="new-body" className="text-sm font-medium">
            正文 (Markdown)
          </label>
          <Textarea
            id="new-body"
            value={body}
            onChange={(e) => setBody(e.target.value)}
            placeholder="使用 Markdown 编写…"
            rows={20}
            className="resize-y font-mono text-sm leading-relaxed"
          />
        </div>

        <details className="rounded-lg border border-border bg-card p-3">
          <summary className="cursor-pointer text-sm font-medium text-muted-foreground">
            结构化字段（可选）
          </summary>
          <div className="mt-3 space-y-2.5">
            {(
              [
                { id: 'bg', label: '背景', value: background, set: setBackground, ph: '调研背景…' },
                { id: 'cc', label: '结论', value: conclusion, set: setConclusion, ph: '调研结论…' },
                { id: 'rk', label: '风险', value: risks, set: setRisks, ph: '风险与待验证项…' },
              ] as const
            ).map((f) => (
              <div key={f.id} className="grid gap-1">
                <label htmlFor={`new-${f.id}`} className="text-xs text-muted-foreground">
                  {f.label}
                </label>
                <Textarea
                  id={`new-${f.id}`}
                  value={f.value}
                  onChange={(e) => f.set(e.target.value)}
                  rows={3}
                  placeholder={f.ph}
                  className="resize-y text-[13px]"
                />
              </div>
            ))}
          </div>
        </details>

        <div className="grid gap-1.5">
          <label htmlFor="new-tags" className="text-sm font-medium">
            标签（逗号分隔）
          </label>
          <Input
            id="new-tags"
            value={tagsInput}
            onChange={(e) => setTagsInput(e.target.value)}
            placeholder="例如: React, TypeScript, 架构"
          />
          {tags.length > 0 && (
            <TagList className="mt-1">
              {tags.map((t) => (
                <TagChip key={t}>{t}</TagChip>
              ))}
            </TagList>
          )}
        </div>
      </div>

      <div className="mt-5 flex justify-end gap-2 border-t border-border pt-4">
        <Button type="button" variant="outline" onClick={() => router.push('/researches')}>
          取消
        </Button>
        <Button type="button" onClick={handleSave} disabled={saving}>
          {saving ? '保存中…' : '保存草稿'}
        </Button>
      </div>
    </div>
  );
}
