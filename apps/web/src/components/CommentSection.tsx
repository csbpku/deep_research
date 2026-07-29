'use client';

// 评论组件：列表 + 输入 + 嵌套回复 + 点赞 + 删除。
//
// 契约源：
//   - /api/summaries/[id]/comments 或 /api/researches/[id]/comments
//   - /api/comments/[id]/star、/api/comments/[id]、/api/comments/my-stars
//
// 设计：
//   - top-level 评论按 createdAt desc 排序；嵌套 1 层（避免无限线程）
//   - 一人一票（CommentStar @@unique）
//   - 作者可删除自己；admin 可删除任意评论

import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';

interface CommentAuthor {
  id: string;
  name: string;
  avatarUrl: string | null;
}

interface ReplyItem {
  id: string;
  body: string;
  starCount: number;
  createdAt: string;
  author: CommentAuthor;
}

interface CommentItem {
  id: string;
  body: string;
  parentId: string | null;
  starCount: number;
  promoteStatus: 'none' | 'nominated' | 'approved' | 'rejected';
  createdAt: string;
  author: CommentAuthor;
  children: ReplyItem[];
  childCount: number;
}

interface CommentListResponse {
  page: number;
  perPage: number;
  total: number;
  totalPages: number;
  items: CommentItem[];
}

export interface CommentSectionProps {
  /** 'summary' or 'research' */
  targetType: 'summary' | 'research';
  /** 目标 id（summary.id 或 research.id） */
  targetId: string;
  /** 当前登录用户 id（用于显示"删除"按钮）；null = 未登录 */
  currentUserId?: string | null;
  /** 当前用户角色 */
  currentUserRole?: 'member' | 'admin' | null;
}

export function CommentSection({
  targetType,
  targetId,
  currentUserId = null,
  currentUserRole = null,
}: CommentSectionProps) {
  const queryClient = useQueryClient();
  const commentsKey = ['comments', targetType, targetId] as const;

  const listQuery = useQuery<CommentListResponse>({
    queryKey: commentsKey,
    queryFn: async () => {
      const r = await fetch(`/api/${targetType === 'summary' ? 'summaries' : 'researches'}/${targetId}/comments`, {
        cache: 'no-store',
      });
      if (!r.ok) {
        const err = await r.json().catch(() => ({ message: '加载失败' }));
        throw new Error(err.message ?? '加载失败');
      }
      return r.json();
    },
  });

  const starsQuery = useQuery<{ commentIds: string[] }>({
    queryKey: ['my-stars'],
    queryFn: async () => {
      const r = await fetch('/api/comments/my-stars', { cache: 'no-store' });
      if (!r.ok) return { commentIds: [] };
      return r.json();
    },
    enabled: Boolean(currentUserId),
  });
  const starredIds = new Set(starsQuery.data?.commentIds ?? []);

  const createMut = useMutation({
    mutationFn: async (input: { body: string; parentId?: string }) => {
      const r = await fetch(`/api/${targetType === 'summary' ? 'summaries' : 'researches'}/${targetId}/comments`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(input),
      });
      if (!r.ok) {
        const err = await r.json().catch(() => ({ message: '发送失败' }));
        throw new Error(err.message ?? '发送失败');
      }
      return r.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: commentsKey });
    },
  });

  const starMut = useMutation({
    mutationFn: async (input: { id: string; action: 'star' | 'unstar' }) => {
      const r = await fetch(`/api/comments/${input.id}/star`, {
        method: input.action === 'star' ? 'POST' : 'DELETE',
      });
      if (!r.ok) {
        const err = await r.json().catch(() => ({ message: '操作失败' }));
        throw new Error(err.message ?? '操作失败');
      }
      return r.json() as Promise<{ starCount: number }>;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: commentsKey });
      queryClient.invalidateQueries({ queryKey: ['my-stars'] });
    },
  });

  const deleteMut = useMutation({
    mutationFn: async (commentId: string) => {
      const r = await fetch(`/api/comments/${commentId}`, { method: 'DELETE' });
      if (!r.ok) {
        const err = await r.json().catch(() => ({ message: '删除失败' }));
        throw new Error(err.message ?? '删除失败');
      }
      return r.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: commentsKey });
    },
  });

  return (
    <div style={sectionStyle} data-testid="comment-section">
      <h2 style={headerStyle}>💬 讨论 ({listQuery.data?.total ?? 0})</h2>

      <CommentInput
        placeholder={currentUserId ? '写下你的看法…' : '请先登录后参与讨论'}
        disabled={!currentUserId || createMut.isPending}
        onSubmit={async (body) => {
          await createMut.mutateAsync({ body });
        }}
      />

      {createMut.isError && (
        <p style={{ color: '#dc2626', fontSize: 12, marginTop: 8 }}>
          {(createMut.error as Error).message}
        </p>
      )}

      {listQuery.isLoading && <p style={{ color: '#94a3b8', fontSize: 13, marginTop: 16 }}>加载中…</p>}

      {listQuery.isError && (
        <p style={{ color: '#dc2626', fontSize: 13, marginTop: 16 }}>{(listQuery.error as Error).message}</p>
      )}

      <div style={{ marginTop: 16 }}>
        {(listQuery.data?.items ?? []).map((c) => (
          <CommentRow
            key={c.id}
            comment={c}
            isAuthor={currentUserId === c.author.id}
            isAdmin={currentUserRole === 'admin'}
            currentUserId={currentUserId}
            starred={starredIds.has(c.id)}
            onStar={(action) => starMut.mutate({ id: c.id, action })}
            onDelete={() => deleteMut.mutate(c.id)}
            onReply={async (body) => {
              await createMut.mutateAsync({ body, parentId: c.id });
            }}
          />
        ))}
        {listQuery.data && listQuery.data.items.length === 0 && (
          <p style={{ color: '#94a3b8', fontSize: 13, padding: '16px 0' }}>还没有评论，来抢沙发吧。</p>
        )}
      </div>
    </div>
  );
}

// ────────────────────────────────────────────────────────────
// 单条评论行
// ────────────────────────────────────────────────────────────

function CommentRow({
  comment,
  isAuthor,
  isAdmin,
  currentUserId,
  starred,
  onStar,
  onDelete,
  onReply,
}: {
  comment: CommentItem;
  isAuthor: boolean;
  isAdmin: boolean;
  currentUserId: string | null;
  starred: boolean;
  onStar: (action: 'star' | 'unstar') => void;
  onDelete: () => void;
  onReply: (body: string) => Promise<void>;
}) {
  const [replyOpen, setReplyOpen] = useState(false);
  const [repliesExpanded, setRepliesExpanded] = useState(false);
  const canDelete = isAuthor || isAdmin;

  return (
    <div
      style={{
        padding: '12px 0',
        borderBottom: '1px solid #f1f5f9',
      }}
    >
      <div style={{ display: 'flex', gap: 10 }}>
        <Avatar user={comment.author} />
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 4, flexWrap: 'wrap' }}>
            <span style={{ fontSize: 13, fontWeight: 600, color: '#0f172a' }}>{comment.author.name}</span>
            <span style={{ fontSize: 11, color: '#94a3b8' }}>{formatRelative(comment.createdAt)}</span>
            {comment.promoteStatus === 'approved' && (
              <span
                style={{
                  fontSize: 10,
                  padding: '1px 6px',
                  background: '#dcfce7',
                  color: '#15803d',
                  borderRadius: 3,
                }}
              >
                ✨ 已提炼为精华
              </span>
            )}
            {comment.promoteStatus === 'rejected' && (
              <span
                style={{
                  fontSize: 10,
                  padding: '1px 6px',
                  background: '#fee2e2',
                  color: '#b91c1c',
                  borderRadius: 3,
                }}
              >
                已拒绝提名
              </span>
            )}
          </div>
          <p
            style={{
              fontSize: 14,
              color: '#1e293b',
              margin: 0,
              lineHeight: 1.7,
              whiteSpace: 'pre-wrap',
              wordBreak: 'break-word',
            }}
          >
            {comment.body}
          </p>

          <div style={{ display: 'flex', gap: 12, marginTop: 6, fontSize: 12, color: '#64748b', alignItems: 'center' }}>
            <button
              type="button"
              onClick={() => onStar(starred ? 'unstar' : 'star')}
              disabled={!currentUserId}
              style={{
                background: 'transparent',
                border: 'none',
                cursor: currentUserId ? 'pointer' : 'default',
                padding: 0,
                color: starred ? '#d97706' : '#64748b',
                fontSize: 12,
              }}
              data-testid={`star-button-${comment.id}`}
            >
              {starred ? '⭐' : '☆'} {comment.starCount > 0 ? comment.starCount : '重要'}
            </button>
            {currentUserId && (
              <button
                type="button"
                onClick={() => setReplyOpen((v) => !v)}
                style={{ background: 'transparent', border: 'none', cursor: 'pointer', padding: 0, color: '#64748b', fontSize: 12 }}
              >
                回复
              </button>
            )}
            {canDelete && (
              <button
                type="button"
                onClick={onDelete}
                style={{
                  background: 'transparent',
                  border: 'none',
                  cursor: 'pointer',
                  padding: 0,
                  color: '#dc2626',
                  fontSize: 12,
                }}
              >
                删除
              </button>
            )}
          </div>

          {/* 回复输入框 */}
          {replyOpen && (
            <div style={{ marginTop: 8 }}>
              <CommentInput
                placeholder={`回复 ${comment.author.name}…`}
                small
                onSubmit={async (body) => {
                  await onReply(body);
                  setReplyOpen(false);
                }}
                onCancel={() => setReplyOpen(false)}
              />
            </div>
          )}

          {/* 嵌套回复 */}
          {comment.children.length > 0 && (
            <div style={{ marginTop: 8, marginLeft: 8, paddingLeft: 12, borderLeft: '2px solid #e2e8f0' }}>
              {comment.children.slice(0, repliesExpanded ? undefined : 2).map((r) => (
                <div key={r.id} style={{ padding: '6px 0' }}>
                  <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 2 }}>
                    <span style={{ fontSize: 12, fontWeight: 600, color: '#0f172a' }}>{r.author.name}</span>
                    <span style={{ fontSize: 11, color: '#94a3b8' }}>{formatRelative(r.createdAt)}</span>
                  </div>
                  <p style={{ fontSize: 13, color: '#334155', margin: 0, lineHeight: 1.6, whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>
                    {r.body}
                  </p>
                </div>
              ))}
              {!repliesExpanded && comment.childCount > comment.children.length && (
                <button
                  type="button"
                  onClick={() => setRepliesExpanded(true)}
                  style={{ background: 'transparent', border: 'none', cursor: 'pointer', color: '#0ea5e9', fontSize: 12, marginTop: 4 }}
                >
                  查看全部 {comment.childCount} 条回复 →
                </button>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

// ────────────────────────────────────────────────────────────
// 评论输入框（textarea + Cmd/Ctrl+Enter 提交）
// ────────────────────────────────────────────────────────────

function CommentInput({
  placeholder,
  disabled,
  onSubmit,
  small = false,
  onCancel,
}: {
  placeholder: string;
  disabled?: boolean;
  onSubmit: (body: string) => Promise<void>;
  small?: boolean;
  onCancel?: () => void;
}) {
  const [body, setBody] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    const trimmed = body.trim();
    if (!trimmed) return;
    setSubmitting(true);
    setError(null);
    try {
      await onSubmit(trimmed);
      setBody('');
    } catch (err) {
      setError(err instanceof Error ? err.message : '发送失败');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div>
      <textarea
        value={body}
        onChange={(e) => setBody(e.target.value)}
        onKeyDown={(e) => {
          if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
            e.preventDefault();
            submit();
          }
        }}
        placeholder={placeholder}
        disabled={disabled}
        rows={small ? 2 : 3}
        style={{
          width: '100%',
          fontSize: small ? 13 : 14,
          padding: small ? '6px 10px' : '8px 12px',
          border: '1px solid #e2e8f0',
          borderRadius: 6,
          resize: 'vertical',
          background: disabled ? '#f8fafc' : '#fff',
          color: '#1e293b',
          outline: 'none',
          fontFamily: 'inherit',
        }}
      />
      {error && <p style={{ color: '#dc2626', fontSize: 12, margin: '4px 0' }}>{error}</p>}
      <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 6 }}>
        {onCancel && (
          <button
            type="button"
            onClick={onCancel}
            style={{ padding: '4px 12px', fontSize: 12, background: '#fff', border: '1px solid #e2e8f0', borderRadius: 4, color: '#64748b', cursor: 'pointer' }}
          >
            取消
          </button>
        )}
        <button
          type="button"
          onClick={submit}
          disabled={disabled || submitting || !body.trim()}
          style={{
            padding: '4px 14px',
            fontSize: 12,
            background: '#0f172a',
            color: '#fff',
            border: 'none',
            borderRadius: 4,
            cursor: disabled || submitting || !body.trim() ? 'not-allowed' : 'pointer',
            opacity: disabled || submitting || !body.trim() ? 0.5 : 1,
          }}
        >
          {submitting ? '发送中…' : '发送 (⌘+Enter)'}
        </button>
      </div>
    </div>
  );
}

// ────────────────────────────────────────────────────────────
// 头像占位
// ────────────────────────────────────────────────────────────

function Avatar({ user }: { user: CommentAuthor }) {
  if (user.avatarUrl) {
    // eslint-disable-next-line @next/next/no-img-element
    return <img src={user.avatarUrl} alt={user.name} style={{ width: 32, height: 32, borderRadius: '50%', objectFit: 'cover', flexShrink: 0 }} />;
  }
  const initial = user.name?.[0] ?? '?';
  const hue = hashHue(user.id);
  return (
    <div
      style={{
        width: 32,
        height: 32,
        borderRadius: '50%',
        background: `hsl(${hue} 70% 55%)`,
        color: '#fff',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        fontSize: 13,
        fontWeight: 600,
        flexShrink: 0,
      }}
    >
      {initial}
    </div>
  );
}

function hashHue(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return Math.abs(h) % 360;
}

function formatRelative(iso: string): string {
  const t = new Date(iso).getTime();
  const diff = Date.now() - t;
  if (diff < 60_000) return '刚刚';
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} 分钟前`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)} 小时前`;
  if (diff < 7 * 86_400_000) return `${Math.floor(diff / 86_400_000)} 天前`;
  return new Date(iso).toLocaleDateString('zh-CN');
}

/** 暴露用于单测；组件外部不直接使用。 */
export const __testing__ = { hashHue, formatRelative };

const sectionStyle: React.CSSProperties = {
  border: '1px solid #e2e8f0',
  borderRadius: 8,
  padding: 20,
  marginTop: 16,
  background: '#fff',
};

const headerStyle: React.CSSProperties = {
  fontSize: 16,
  fontWeight: 600,
  color: '#0f172a',
  margin: '0 0 12px',
};