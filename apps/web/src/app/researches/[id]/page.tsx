'use client';

// 沉淀详情页 —— 只读视图 + 操作按钮
//
// draft: 仅 owner 可见；显示「编辑」「发布」按钮
// published: 全员可见；owner 可编辑

import { useParams, useRouter } from 'next/navigation';
import { useQuery } from '@tanstack/react-query';
import Link from 'next/link';

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
  updatedAt: string;
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

export default function ResearchDetailPage() {
  const params = useParams<{ id: string }>();
  const router = useRouter();

  const { data, isLoading, isError, error } = useQuery<ResearchDetail>({
    queryKey: ['research', params.id],
    queryFn: async () => {
      const res = await fetch(`/api/researches/${params.id}`);
      if (!res.ok) {
        if (res.status === 404) throw new Error('沉淀不存在');
        throw new Error('加载失败');
      }
      return res.json();
    },
  });

  if (isLoading) {
    return <p style={{ textAlign: 'center', color: '#94a3b8', padding: 60 }}>加载中...</p>;
  }

  if (isError || !data) {
    return (
      <div style={{ textAlign: 'center', padding: 60 }}>
        <h2 style={{ fontSize: 18, color: '#475569' }}>{error instanceof Error ? error.message : '沉淀不存在'}</h2>
        <Link href="/researches" style={{ fontSize: 14, color: '#0f172a' }}>返回列表</Link>
      </div>
    );
  }

  const isOwner = true; // 列表/详情页 API 都是 owner 才可编辑；前端没法可靠知道当前 userId

  return (
    <div>
      {/* 头部 */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 20 }}>
        <div>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 8 }}>
            <Link
              href="/researches"
              style={{ fontSize: 13, color: '#64748b', textDecoration: 'none' }}
            >
              沉淀
            </Link>
            <span style={{ color: '#94a3b8' }}>/</span>
            <span style={{ fontSize: 13, color: '#475569' }}>{data.title}</span>
          </div>

          <h1 style={{ fontSize: 24, margin: '0 0 8px' }}>{data.title}</h1>

          <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
            <span style={{
              padding: '2px 8px',
              borderRadius: 4,
              fontSize: 11,
              fontWeight: 600,
              background: '#f1f5f9',
              color: '#475569',
              border: '1px solid #e2e8f0',
            }}>
              {data.creationMethod === 'manual' ? '手写' :
               data.creationMethod === 'ai_research' ? 'AI 调研' :
               data.creationMethod === 'file_import' ? '文件导入' : 'Confluence'}
            </span>
            {data.aiAssisted && (
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
            {data.status === 'draft' && (
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

          <div style={{ display: 'flex', gap: 12, marginTop: 8, fontSize: 13, color: '#94a3b8' }}>
            <span>作者: {data.author.name}</span>
            <span>创建: {new Date(data.createdAt).toLocaleString('zh-CN')}</span>
            {data.publishedAt && <span>发布: {new Date(data.publishedAt).toLocaleString('zh-CN')}</span>}
            {data.commentCount !== undefined && <span>评论: {data.commentCount}</span>}
          </div>
        </div>

        <div style={{ display: 'flex', gap: 8 }}>
          <Link
            href={`/researches/${data.id}/edit`}
            style={{
              padding: '6px 14px',
              border: '1px solid #0f172a',
              borderRadius: 6,
              background: '#fff',
              color: '#0f172a',
              textDecoration: 'none',
              fontSize: 13,
            }}
          >
            编辑
          </Link>
        </div>
      </div>

      {/* 标签 */}
      {data.tags.length > 0 && (
        <div style={{ display: 'flex', gap: 6, marginBottom: 20, flexWrap: 'wrap' }}>
          {data.tags.map((t) => (
            <span key={t} style={{
              padding: '2px 10px',
              borderRadius: 6,
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

      {/* 结构化字段 */}
      {(data.background || data.conclusion || data.risks) && (
        <div style={{ border: '1px solid #e2e8f0', borderRadius: 8, padding: 16, marginBottom: 20, background: '#f8fafc' }}>
          {data.background && (
            <div style={{ marginBottom: 12 }}>
              <h3 style={{ fontSize: 14, color: '#475569', margin: '0 0 4px' }}>背景</h3>
              <p style={{ margin: 0, fontSize: 13, lineHeight: 1.6, color: '#334155' }}>{data.background}</p>
            </div>
          )}
          {data.conclusion && (
            <div style={{ marginBottom: 12 }}>
              <h3 style={{ fontSize: 14, color: '#475569', margin: '0 0 4px' }}>结论</h3>
              <p style={{ margin: 0, fontSize: 13, lineHeight: 1.6, color: '#334155' }}>{data.conclusion}</p>
            </div>
          )}
          {data.risks && (
            <div>
              <h3 style={{ fontSize: 14, color: '#475569', margin: '0 0 4px' }}>风险</h3>
              <p style={{ margin: 0, fontSize: 13, lineHeight: 1.6, color: '#334155' }}>{data.risks}</p>
            </div>
          )}
        </div>
      )}

      {/* 正文 */}
      <div style={{
        border: '1px solid #e2e8f0',
        borderRadius: 8,
        padding: 24,
        background: '#fff',
        lineHeight: 1.8,
        fontSize: 15,
        color: '#1e293b',
      }}>
        <pre style={{
          whiteSpace: 'pre-wrap',
          wordBreak: 'break-word',
          fontFamily: 'inherit',
          fontSize: 'inherit',
          margin: 0,
          lineHeight: 1.8,
        }}>
          {data.body}
        </pre>
      </div>

      {/* 审计历史 */}
      {data.audits && data.audits.length > 0 && (
        <details style={{ marginTop: 20 }}>
          <summary style={{ fontSize: 13, fontWeight: 500, color: '#475569', cursor: 'pointer' }}>
            修改历史 ({data.audits.length})
          </summary>
          <div style={{ marginTop: 8 }}>
            {data.audits.map((a) => (
              <div key={a.id} style={{ padding: '8px 0', borderBottom: '1px solid #f1f5f9', fontSize: 12, color: '#64748b' }}>
                <span style={{ fontWeight: 500 }}>{a.action === 'create' ? '创建' : a.action === 'edit' ? '编辑' : a.action === 'publish' ? '发布' : a.action}</span>
                {' '}by {a.editor.name} at {new Date(a.createdAt).toLocaleString('zh-CN')}
                {a.diff && typeof a.diff === 'object' && Object.keys(a.diff as Record<string, unknown>).length > 0 ? (
                  <span style={{ color: '#94a3b8' }}>
                    {' '}({Object.keys(a.diff as Record<string, unknown>).join(', ')} 变更)
                  </span>
                ) : null}
              </div>
            ))}
          </div>
        </details>
      )}
    </div>
  );
}
