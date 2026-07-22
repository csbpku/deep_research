'use client';

// /researches/new — 新建沉淀入口，再导出编辑器组件。
// 编辑器本身已处理 isNew 逻辑（/app/researches/[id]/edit/page.tsx）。
// 这个页面就是编辑器，但 params.id 不存在。
//
// 简化实现：直接在新页路由下展示编辑 UI（避免 import 复用问题）。

import { useState, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import { useMutation, useQueryClient } from '@tanstack/react-query';

export default function NewResearchPage() {
  const router = useRouter();
  const queryClient = useQueryClient();

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
        title: title || '未命名沉淀',
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

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
        <h1 style={{ fontSize: 22, margin: 0 }}>新建沉淀</h1>
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
          onClick={() => router.push('/researches')}
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
            padding: '8px 20px',
            border: 'none',
            borderRadius: 6,
            background: '#0f172a',
            color: '#fff',
            cursor: saving ? 'default' : 'pointer',
            fontSize: 13,
            opacity: saving ? 0.6 : 1,
          }}
        >
          {saving ? '保存中...' : '保存草稿'}
        </button>
      </div>
    </div>
  );
}
