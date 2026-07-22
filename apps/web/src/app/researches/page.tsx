'use client';

// 沉淀列表页：research / knowledge tab 切换。
//
// 功能：
//   - 长文 (research) / 精华 (knowledge) tab
//   - 卡片：标题、标签、creationMethod 徽标、draft 标签、作者、状态
//   - 新建按钮 → 跳转编辑页
//   - 分页

import { useState } from 'react';
import Link from 'next/link';
import { useQuery } from '@tanstack/react-query';

interface ResearchItem {
  id: string;
  type: string;
  status: string;
  title: string;
  body: string;
  tags: string[];
  authorId: string;
  creationMethod: string;
  aiAssisted: boolean;
  publishedAt: string | null;
  createdAt: string;
  author: { id: string; name: string };
}

interface ListResponse {
  items: ResearchItem[];
  page: number;
  limit: number;
  total: number;
  totalPages: number;
}

function methodLabel(method: string): string {
  switch (method) {
    case 'manual': return '手写';
    case 'ai_research': return 'AI 调研';
    case 'file_import': return '文件导入';
    case 'confluence_import': return 'Confluence';
    default: return method;
  }
}

function methodColor(method: string): string {
  switch (method) {
    case 'manual': return '#475569';
    case 'ai_research': return '#7c3aed';
    case 'file_import': return '#0ea5e9';
    case 'confluence_import': return '#059669';
    default: return '#94a3b8';
  }
}

export default function ResearchesPage() {
  const [tab, setTab] = useState<'research' | 'knowledge'>('research');
  const [page, setPage] = useState(1);

  const { data, isLoading, isError } = useQuery<ListResponse>({
    queryKey: ['researches', tab, page],
    queryFn: async () => {
      const params = new URLSearchParams({ type: tab, page: String(page), limit: '20' });
      const res = await fetch(`/api/researches?${params}`);
      if (!res.ok) throw new Error('Failed to fetch');
      return res.json();
    },
  });

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
        <h1 style={{ fontSize: 22, margin: 0 }}>沉淀</h1>
        <Link
          href="/researches/new"
          style={{
            border: '1px solid #0f172a',
            background: '#0f172a',
            color: '#fff',
            padding: '6px 14px',
            borderRadius: 6,
            fontSize: 13,
            textDecoration: 'none',
          }}
        >
          + 新建
        </Link>
      </div>

      {/* Tabs */}
      <div style={{ display: 'flex', gap: 2, marginBottom: 16, borderBottom: '1px solid #e2e8f0' }}>
        <button
          onClick={() => { setTab('research'); setPage(1); }}
          style={{
            padding: '8px 16px',
            border: 'none',
            background: 'transparent',
            borderBottom: tab === 'research' ? '2px solid #0f172a' : '2px solid transparent',
            fontWeight: tab === 'research' ? 600 : 400,
            cursor: 'pointer',
            color: '#0f172a',
            fontSize: 14,
          }}
        >
          长文
        </button>
        <button
          onClick={() => { setTab('knowledge'); setPage(1); }}
          style={{
            padding: '8px 16px',
            border: 'none',
            background: 'transparent',
            borderBottom: tab === 'knowledge' ? '2px solid #0f172a' : '2px solid transparent',
            fontWeight: tab === 'knowledge' ? 600 : 400,
            cursor: 'pointer',
            color: '#0f172a',
            fontSize: 14,
          }}
        >
          精华
        </button>
      </div>

      {isLoading && <p style={{ color: '#94a3b8', textAlign: 'center', padding: 40 }}>加载中...</p>}
      {isError && <p style={{ color: '#ef4444', textAlign: 'center', padding: 40 }}>加载失败，请稍后重试</p>}

      {data && data.items.length === 0 && (
        <p style={{ color: '#94a3b8', textAlign: 'center', padding: 40 }}>
          暂无{tab === 'research' ? '长文' : '精华'}
        </p>
      )}

      {data && data.items.map((item) => (
        <Link
          key={item.id}
          href={`/researches/${item.id}`}
          style={{
            display: 'block',
            border: '1px solid #e2e8f0',
            borderRadius: 8,
            background: '#fff',
            padding: 16,
            marginBottom: 12,
            textDecoration: 'none',
            color: 'inherit',
            position: 'relative',
          }}
        >
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 6 }}>
            <span
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: 4,
                padding: '2px 8px',
                borderRadius: 4,
                fontSize: 11,
                fontWeight: 600,
                background: `${methodColor(item.creationMethod)}15`,
                color: methodColor(item.creationMethod),
                border: `1px solid ${methodColor(item.creationMethod)}30`,
              }}
            >
              {methodLabel(item.creationMethod)}
            </span>
            {item.aiAssisted && (
              <span style={{
                padding: '2px 8px',
                borderRadius: 4,
                fontSize: 11,
                background: '#ede9fe',
                color: '#7c3aed',
                border: '1px solid #c4b5fd',
              }}>
                AI 协助
              </span>
            )}
            {item.status === 'draft' && (
              <span style={{
                padding: '2px 8px',
                borderRadius: 4,
                fontSize: 11,
                background: '#fef3c7',
                color: '#92400e',
                border: '1px solid #fcd34d',
              }}>
                草稿
              </span>
            )}
          </div>

          <h3 style={{ margin: '0 0 6px', fontSize: 16, fontWeight: 600 }}>
            {item.title}
          </h3>

          <p style={{ margin: '0 0 8px', fontSize: 13, color: '#475569', lineHeight: 1.5 }}>
            {excerpt(item.body, 200)}
          </p>

          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 6 }}>
            {item.tags.map((t) => (
              <span key={t} style={{
                padding: '1px 6px',
                borderRadius: 4,
                fontSize: 11,
                background: '#f1f5f9',
                color: '#475569',
              }}>
                {t}
              </span>
            ))}
          </div>

          <div style={{ display: 'flex', gap: 12, fontSize: 12, color: '#94a3b8' }}>
            <span>{item.author.name}</span>
            <span>{item.publishedAt ? new Date(item.publishedAt).toLocaleDateString('zh-CN') : new Date(item.createdAt).toLocaleDateString('zh-CN')}</span>
          </div>
        </Link>
      ))}

      {/* Pagination */}
      {data && data.totalPages > 1 && (
        <div style={{ display: 'flex', justifyContent: 'center', gap: 8, marginTop: 16 }}>
          <button
            disabled={page <= 1}
            onClick={() => setPage((p) => Math.max(1, p - 1))}
            style={{
              padding: '4px 12px',
              border: '1px solid #e2e8f0',
              borderRadius: 4,
              background: '#fff',
              cursor: page <= 1 ? 'default' : 'pointer',
              opacity: page <= 1 ? 0.4 : 1,
            }}
          >
            上一页
          </button>
          <span style={{ padding: '4px 8px', fontSize: 13, color: '#475569' }}>
            {page} / {data.totalPages}
          </span>
          <button
            disabled={page >= data.totalPages}
            onClick={() => setPage((p) => Math.min(data.totalPages, p + 1))}
            style={{
              padding: '4px 12px',
              border: '1px solid #e2e8f0',
              borderRadius: 4,
              background: '#fff',
              cursor: page >= data.totalPages ? 'default' : 'pointer',
              opacity: page >= data.totalPages ? 0.4 : 1,
            }}
          >
            下一页
          </button>
        </div>
      )}
    </div>
  );
}

function excerpt(body: string, max: number): string {
  const plainText = body.replace(/[#*`>\-\[\]()!_~|]/g, '').replace(/\s+/g, ' ').trim();
  if (plainText.length <= max) return plainText;
  return plainText.slice(0, max) + '...';
}
