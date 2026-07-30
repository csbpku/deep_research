'use client';

// 沉淀详情页 —— 增量 W4：按 type 分支显示长文 / 精华布局。
//
// draft: 仅 owner 可见；显示「编辑」「发布」按钮
// published: 全员可见；owner / admin 可编辑（W3 canEdit 由服务端计算）
//
// type='research'（长文）：背景 → 正文 → 结论 → 风险 → research_sources 列表
// type='knowledge'（精华）：sourceComment 引用 → 短 body → 来源评论跳转
// W8：在 published 页面底部追加 CommentSection。

import { useParams, useRouter } from 'next/navigation';
import { useQuery } from '@tanstack/react-query';
import Link from 'next/link';
import { CommentSection } from '../../../components/CommentSection';
import { useCurrentUser } from '../../../lib/auth/client';

interface ResearchSourceItem {
  id: string;
  sourceRef: { type?: string; value?: string } | unknown;
  canonicalKey: string;
  title: string | null;
  description: string | null;
}

interface SourceCommentItem {
  id: string;
  body: string;
  authorId: string;
  authorName: string;
  targetType: 'research' | 'summary';
  targetId: string | null;
  targetTitle: string | null;
}

interface ResearchDetail {
  id: string;
  type: 'research' | 'knowledge';
  status: 'draft' | 'published' | 'archived';
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
  canEdit: boolean;
  researchSources: ResearchSourceItem[];
  sourceComment: SourceCommentItem | null;
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

  const isLongResearch = data.type === 'research';
  const isKnowledge = data.type === 'knowledge';
  const isDraft = data.status === 'draft';

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
              background: isLongResearch ? '#dbeafe' : '#ffedd5',
              color: isLongResearch ? '#1d4ed8' : '#7c2d12',
              border: `1px solid ${isLongResearch ? '#bfdbfe' : '#fed7aa'}`,
            }}>
              {isLongResearch ? '长文' : '精华'}
            </span>
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
            {isDraft && (
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

        {data.canEdit && (
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
        )}
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

      {/* ── 长文布局：background → body → conclusion → risks → research_sources ── */}
      {isLongResearch && (
        <>
          {data.background && (
            <section style={sectionStyle}>
              <h2 style={sectionHeaderStyle}>背景</h2>
              <p style={sectionBodyStyle}>{data.background}</p>
            </section>
          )}

          <section style={sectionStyle}>
            <h2 style={sectionHeaderStyle}>正文</h2>
            <pre style={{
              whiteSpace: 'pre-wrap',
              wordBreak: 'break-word',
              fontFamily: 'inherit',
              fontSize: 15,
              margin: 0,
              lineHeight: 1.8,
              color: '#1e293b',
            }}>
              {data.body}
            </pre>
          </section>

          {data.conclusion && (
            <section style={sectionStyle}>
              <h2 style={sectionHeaderStyle}>结论</h2>
              <p style={sectionBodyStyle}>{data.conclusion}</p>
            </section>
          )}

          {data.risks && (
            <section style={sectionStyle}>
              <h2 style={sectionHeaderStyle}>风险</h2>
              <p style={sectionBodyStyle}>{data.risks}</p>
            </section>
          )}

          {/* research_sources：仅已发布长文挂载（draft 不展示） */}
          {data.status === 'published' && data.researchSources.length > 0 && (
            <section style={{ ...sectionStyle, background: '#f8fafc' }}>
              <h2 style={sectionHeaderStyle}>挂载资料 ({data.researchSources.length})</h2>
              <ul style={{ listStyle: 'none', padding: 0, margin: 0 }}>
                {data.researchSources.map((s) => {
                  const ref = (s.sourceRef ?? {}) as { type?: string; value?: string };
                  const href = sourceHrefForRef(ref);
                  return (
                    <li
                      key={s.id}
                      style={{
                        padding: '10px 0',
                        borderBottom: '1px solid #e2e8f0',
                        fontSize: 13,
                      }}
                    >
                      <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                        <span style={{
                          padding: '1px 6px',
                          fontSize: 10,
                          background: '#e0e7ff',
                          color: '#3730a3',
                          borderRadius: 3,
                          fontWeight: 600,
                        }}>
                          {ref.type ?? 'unknown'}
                        </span>
                        {href ? (
                          <a
                            href={href}
                            target="_blank"
                            rel="noreferrer noopener"
                            style={{ color: '#0f172a', textDecoration: 'none', fontWeight: 500 }}
                          >
                            {s.title ?? ref.value ?? s.canonicalKey}
                          </a>
                        ) : (
                          <span style={{ color: '#0f172a', fontWeight: 500 }}>
                            {s.title ?? s.canonicalKey}
                          </span>
                        )}
                      </div>
                      {s.description && (
                        <p style={{ fontSize: 12, color: '#64748b', margin: '4px 0 0' }}>
                          {s.description}
                        </p>
                      )}
                      <p style={{ fontSize: 11, color: '#94a3b8', margin: '2px 0 0' }}>
                        {s.canonicalKey}
                      </p>
                    </li>
                  );
                })}
              </ul>
            </section>
          )}
        </>
      )}

      {/* ── 精华布局：sourceComment 引用 + 短 body + 来源评论跳转 ── */}
      {isKnowledge && (
        <>
          {data.sourceComment && (
            <section style={{ ...sectionStyle, background: '#fff7ed', borderColor: '#fed7aa' }}>
              <h2 style={{ ...sectionHeaderStyle, color: '#9a3412' }}>来源评论</h2>
              <blockquote style={{
                margin: 0,
                padding: '8px 12px',
                background: '#fff',
                border: '1px solid #fed7aa',
                borderRadius: 6,
                fontSize: 13,
                color: '#7c2d12',
                lineHeight: 1.6,
              }}>
                {data.sourceComment.body}
              </blockquote>
              <div style={{ display: 'flex', gap: 8, fontSize: 12, color: '#9a3412', marginTop: 8 }}>
                <span>by {data.sourceComment.authorName}</span>
                {data.sourceComment.targetId && (
                  <Link
                    href={data.sourceComment.targetType === 'summary'
                      ? `/summaries/${data.sourceComment.targetId}`
                      : `/researches/${data.sourceComment.targetId}`}
                    style={{ color: '#9a3412', textDecoration: 'underline' }}
                  >
                    查看原始{data.sourceComment.targetType === 'summary' ? '摘要' : '长文'}: {data.sourceComment.targetTitle ?? '...'}
                  </Link>
                )}
              </div>
            </section>
          )}

          <section style={sectionStyle}>
            <h2 style={sectionHeaderStyle}>正文</h2>
            <pre style={{
              whiteSpace: 'pre-wrap',
              wordBreak: 'break-word',
              fontFamily: 'inherit',
              fontSize: 15,
              margin: 0,
              lineHeight: 1.8,
              color: '#1e293b',
            }}>
              {data.body}
            </pre>
          </section>

          {data.background && (
            <section style={sectionStyle}>
              <h2 style={sectionHeaderStyle}>背景</h2>
              <p style={sectionBodyStyle}>{data.background}</p>
            </section>
          )}

          {data.conclusion && (
            <section style={sectionStyle}>
              <h2 style={sectionHeaderStyle}>结论</h2>
              <p style={sectionBodyStyle}>{data.conclusion}</p>
            </section>
          )}
        </>
      )}

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

      {/* W8 评论区（仅已发布状态可见） */}
      {data.status === 'published' && (
        <PublishedCommentSection researchId={data.id} />
      )}
    </div>
  );
}

function PublishedCommentSection({ researchId }: { researchId: string }) {
  const me = useCurrentUser();
  return (
    <CommentSection
      targetType="research"
      targetId={researchId}
      currentUserId={me.data?.id ?? null}
      currentUserRole={me.data?.role ?? null}
    />
  );
}

const sectionStyle: React.CSSProperties = {
  border: '1px solid #e2e8f0',
  borderRadius: 8,
  padding: 20,
  marginBottom: 16,
  background: '#fff',
};

const sectionHeaderStyle: React.CSSProperties = {
  fontSize: 14,
  fontWeight: 600,
  color: '#475569',
  margin: '0 0 8px',
};

const sectionBodyStyle: React.CSSProperties = {
  margin: 0,
  fontSize: 14,
  lineHeight: 1.7,
  color: '#334155',
  whiteSpace: 'pre-wrap',
};

function sourceHrefForRef(ref: { type?: string; value?: string }): string | null {
  if (!ref.value) return null;
  if (ref.type === 'url') return ref.value;
  if (ref.type === 'doi') return `https://doi.org/${ref.value}`;
  if (ref.type === 'arxiv') return `https://arxiv.org/abs/${ref.value}`;
  return null;
}