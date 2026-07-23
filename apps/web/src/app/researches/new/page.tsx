'use client';

// /researches/new — 新建沉淀入口。
//
// 提供两个入口卡片：
//   1. "从空白创建" → 表单（标题 + 正文 + 结构化字段 + 标签）
//   2. "从文件导入" → /researches/import（弹窗 + 转换 + Markdown 预览）
//
// W4 review 修订：原来只有空白创建；W4 加卡片化入口，让 import 入口可见。

import { useState, useCallback } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useMutation, useQueryClient } from '@tanstack/react-query';

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

  if (mode === 'pick') {
    return (
      <div>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 8 }}>
          <Link href="/researches" style={{ fontSize: 13, color: '#64748b', textDecoration: 'none' }}>
            沉淀
          </Link>
          <span style={{ color: '#94a3b8' }}>/</span>
          <span style={{ fontSize: 13, color: '#475569' }}>新建</span>
        </div>
        <h1 style={{ fontSize: 22, margin: '0 0 16px' }}>新建沉淀</h1>

        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
          <button
            onClick={() => setMode('create')}
            style={{
              border: '1px solid #e2e8f0',
              borderRadius: 8,
              padding: 24,
              background: '#fff',
              cursor: 'pointer',
              textAlign: 'left',
              fontFamily: 'inherit',
            }}
          >
            <div style={{ fontSize: 15, fontWeight: 600, marginBottom: 4 }}>从空白创建</div>
            <div style={{ fontSize: 13, color: '#64748b' }}>
              直接写标题 + 正文 + 背景 / 结论 / 风险 / 标签
            </div>
          </button>

          <Link
            href="/researches/import"
            style={{
              border: '1px solid #e2e8f0',
              borderRadius: 8,
              padding: 24,
              background: '#fff',
              cursor: 'pointer',
              textDecoration: 'none',
              color: '#0f172a',
              display: 'block',
            }}
          >
            <div style={{ fontSize: 15, fontWeight: 600, marginBottom: 4 }}>从文件导入</div>
            <div style={{ fontSize: 13, color: '#64748b' }}>
              拖拽 .md / .txt / .html（≤ 5MB）→ 自动转 Markdown → 个人草稿
            </div>
          </Link>
        </div>
      </div>
    );
  }

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
        <h1 style={{ fontSize: 22, margin: 0 }}>新建沉淀</h1>
        <button
          onClick={() => setMode('pick')}
          style={{
            padding: '6px 12px',
            border: '1px solid #e2e8f0',
            borderRadius: 4,
            background: '#fff',
            cursor: 'pointer',
            fontSize: 12,
          }}
        >
          返回
        </button>
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