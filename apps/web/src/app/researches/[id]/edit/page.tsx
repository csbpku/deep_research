'use client';

// 沉淀编辑器页面 —— 新建 + 编辑。
//
// 路由：
//   /researches/new  → 空白编辑器（创建新草稿）
//   /researches/[id]/edit → 编辑已有草稿或已发布内容
//
// 功能：
//   - Markdown 正文（textarea）
//   - 结构化字段：标题、背景、结论、风险
//   - 标签
//   - 保存草稿 / 发布
//   - creationMethod 徽标

import { useState, useEffect, useCallback } from 'react';
import { useRouter, useParams } from 'next/navigation';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';

interface ResearchDetail {
  id: string;
  type: string;
  status: string;
  title: string;
  body: string;
  background: string | null;
  conclusion: string | null;
  risks: string | null;
  tags: string[];
  authorId: string;
  creationMethod: string;
  aiAssisted: boolean;
  publishedAt: string | null;
  createdAt: string;
  author: { id: string; name: string };
  audits?: AuditEntry[];
  commentCount?: number;
}

interface AuditEntry {
  id: string;
  action: string;
  diff: unknown;
  createdAt: string;
  editor: { id: string; name: string };
}

function methodBg(method: string): string {
  switch (method) {
    case 'ai_research': return '#ede9fe';
    case 'file_import': return '#e0f2fe';
    case 'manual': return '#f1f5f9';
    default: return '#f1f5f9';
  }
}

export default function EditorPage() {
  const router = useRouter();
  const params = useParams<{ id: string }>();
  const queryClient = useQueryClient();
  const isNew = !params?.id || params.id === 'new';

  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [background, setBackground] = useState('');
  const [conclusion, setConclusion] = useState('');
  const [risks, setRisks] = useState('');
  const [tagsInput, setTagsInput] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  // 加载已有数据
  const { data: existing, isLoading: loadingExisting } = useQuery<ResearchDetail>({
    queryKey: ['research', params?.id],
    queryFn: async () => {
      const res = await fetch(`/api/researches/${params!.id}`);
      if (!res.ok) throw new Error('Failed to fetch');
      return res.json();
    },
    enabled: !isNew && !!params?.id,
  });

  useEffect(() => {
    if (existing) {
      setTitle(existing.title);
      setBody(existing.body);
      setBackground(existing.background ?? '');
      setConclusion(existing.conclusion ?? '');
      setRisks(existing.risks ?? '');
      setTagsInput(existing.tags.join(', '));
    }
  }, [existing]);

  const tags = tagsInput
    .split(',')
    .map((t) => t.trim())
    .filter(Boolean);

  // 保存草稿
  const saveMutation = useMutation({
    mutationFn: async () => {
      const payload = { title, body, background: background || null, conclusion: conclusion || null, risks: risks || null, tags };
      let res: Response;
      if (isNew) {
        res = await fetch('/api/researches', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            ...payload,
            title: title || '未命名沉淀',
            body: body || '# 开始编写...',
          }),
        });
      } else {
        res = await fetch(`/api/researches/${params!.id}`, {
          method: 'PUT',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(payload),
        });
      }
      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.message ?? '保存失败');
      }
      return res.json();
    },
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: ['researches'] });
      if (isNew) {
        router.replace(`/researches/${data.id}/edit`);
      }
    },
    onError: (e: Error) => {
      setError(e.message);
    },
  });

  const handleSave = useCallback(async () => {
    setError('');
    setSaving(true);
    try {
      await saveMutation.mutateAsync();
    } finally {
      setSaving(false);
    }
  }, [saveMutation]);

  // 发布
  const publishMutation = useMutation({
    mutationFn: async () => {
      const res = await fetch(`/api/researches/${existing?.id}/publish`, { method: 'POST' });
      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.message ?? '发布失败');
      }
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['researches'] });
      router.push(`/researches/${existing?.id}`);
    },
    onError: (e: Error) => {
      setError(e.message);
    },
  });

  const handlePublish = useCallback(async () => {
    if (!existing) return;
    setError('');
    await publishMutation.mutateAsync();
  }, [existing, publishMutation]);

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
        <h1 style={{ fontSize: 22, margin: 0 }}>
          {isNew ? '新建沉淀' : `编辑: ${existing?.title ?? '...'}`}
        </h1>
        <div style={{ display: 'flex', gap: 8 }}>
          {existing?.creationMethod && (
            <span style={{
              padding: '2px 10px',
              borderRadius: 6,
              fontSize: 12,
              background: methodBg(existing.creationMethod),
              color: '#475569',
              border: '1px solid #e2e8f0',
            }}>
              {existing.creationMethod === 'manual' ? '手写' :
               existing.creationMethod === 'ai_research' ? 'AI 调研' :
               existing.creationMethod === 'file_import' ? '文件导入' : 'Confluence'}
            </span>
          )}
        </div>
      </div>

      {error && (
        <div style={{ border: '1px solid #fecaca', background: '#fef2f2', color: '#dc2626', padding: '12px', borderRadius: 6, marginBottom: 12 }}>
          {error}
        </div>
      )}

      {/* 标题 */}
      <div style={{ marginBottom: 12 }}>
        <label style={{ display: 'block', fontSize: 13, fontWeight: 500, marginBottom: 4, color: '#475569' }}>
          标题
        </label>
        <input
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          placeholder="输入标题..."
          style={{
            width: '100%',
            padding: '8px 12px',
            border: '1px solid #e2e8f0',
            borderRadius: 6,
            fontSize: 15,
            boxSizing: 'border-box',
          }}
        />
      </div>

      {/* 正文 */}
      <div style={{ marginBottom: 12 }}>
        <label style={{ display: 'block', fontSize: 13, fontWeight: 500, marginBottom: 4, color: '#475569' }}>
          正文 (Markdown)
        </label>
        <textarea
          value={body}
          onChange={(e) => setBody(e.target.value)}
          placeholder="使用 Markdown 编写..."
          rows={20}
          style={{
            width: '100%',
            padding: '12px',
            border: '1px solid #e2e8f0',
            borderRadius: 6,
            fontSize: 14,
            fontFamily: 'monospace',
            lineHeight: 1.6,
            resize: 'vertical',
            boxSizing: 'border-box',
          }}
        />
      </div>

      {/* 结构化字段 */}
      <details style={{ marginBottom: 12 }}>
        <summary style={{ fontSize: 13, fontWeight: 500, color: '#475569', cursor: 'pointer' }}>
          结构化字段（可选）
        </summary>
        <div style={{ marginTop: 8, display: 'flex', flexDirection: 'column', gap: 10 }}>
          <div>
            <label style={{ display: 'block', fontSize: 12, color: '#94a3b8', marginBottom: 2 }}>背景</label>
            <textarea
              value={background}
              onChange={(e) => setBackground(e.target.value)}
              rows={3}
              placeholder="调研背景..."
              style={{ width: '100%', padding: '6px 10px', border: '1px solid #e2e8f0', borderRadius: 4, fontSize: 13, boxSizing: 'border-box', resize: 'vertical' }}
            />
          </div>
          <div>
            <label style={{ display: 'block', fontSize: 12, color: '#94a3b8', marginBottom: 2 }}>结论</label>
            <textarea
              value={conclusion}
              onChange={(e) => setConclusion(e.target.value)}
              rows={3}
              placeholder="调研结论..."
              style={{ width: '100%', padding: '6px 10px', border: '1px solid #e2e8f0', borderRadius: 4, fontSize: 13, boxSizing: 'border-box', resize: 'vertical' }}
            />
          </div>
          <div>
            <label style={{ display: 'block', fontSize: 12, color: '#94a3b8', marginBottom: 2 }}>风险</label>
            <textarea
              value={risks}
              onChange={(e) => setRisks(e.target.value)}
              rows={3}
              placeholder="风险与待验证项..."
              style={{ width: '100%', padding: '6px 10px', border: '1px solid #e2e8f0', borderRadius: 4, fontSize: 13, boxSizing: 'border-box', resize: 'vertical' }}
            />
          </div>
        </div>
      </details>

      {/* 标签 */}
      <div style={{ marginBottom: 20 }}>
        <label style={{ display: 'block', fontSize: 13, fontWeight: 500, marginBottom: 4, color: '#475569' }}>
          标签（逗号分隔）
        </label>
        <input
          value={tagsInput}
          onChange={(e) => setTagsInput(e.target.value)}
          placeholder="例如: React, TypeScript, 架构"
          style={{
            width: '100%',
            padding: '8px 12px',
            border: '1px solid #e2e8f0',
            borderRadius: 6,
            fontSize: 14,
            boxSizing: 'border-box',
          }}
        />
        {tags.length > 0 && (
          <div style={{ display: 'flex', gap: 6, marginTop: 6, flexWrap: 'wrap' }}>
            {tags.map((t) => (
              <span key={t} style={{
                padding: '2px 8px',
                borderRadius: 4,
                fontSize: 12,
                background: '#f1f5f9',
                color: '#475569',
                border: '1px solid #e2e8f0',
              }}>
                {t}
              </span>
            ))}
          </div>
        )}
      </div>

      {/* Actions */}
      <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', borderTop: '1px solid #e2e8f0', paddingTop: 16 }}>
        <button
          onClick={() => router.back()}
          style={{
            padding: '8px 16px',
            border: '1px solid #e2e8f0',
            borderRadius: 6,
            background: '#fff',
            cursor: 'pointer',
            fontSize: 13,
          }}
        >
          取消
        </button>
        <button
          onClick={handleSave}
          disabled={saving}
          style={{
            padding: '8px 16px',
            border: '1px solid #0f172a',
            borderRadius: 6,
            background: '#fff',
            cursor: saving ? 'default' : 'pointer',
            fontSize: 13,
            opacity: saving ? 0.6 : 1,
          }}
        >
          {saving ? '保存中...' : '保存草稿'}
        </button>
        {existing && existing.status === 'draft' && (
          <button
            onClick={handlePublish}
            disabled={publishMutation.isPending}
            style={{
              padding: '8px 20px',
              border: 'none',
              borderRadius: 6,
              background: '#0f172a',
              color: '#fff',
              cursor: publishMutation.isPending ? 'default' : 'pointer',
              fontSize: 13,
              opacity: publishMutation.isPending ? 0.6 : 1,
            }}
          >
            {publishMutation.isPending ? '发布中...' : '发布'}
          </button>
        )}
      </div>
    </div>
  );
}
