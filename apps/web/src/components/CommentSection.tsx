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
//
// ⚠️ e2e 契约：data-testid="comment-section"、data-testid={`star-button-${id}`}

import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { MessageSquare, Sparkles, Star } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { Skeleton } from '@/components/ui/skeleton';
import { cn } from '@/lib/utils';

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
    <section
      className="mt-4 rounded-md border border-border bg-card p-4"
      data-testid="comment-section"
    >
      <h2 className="mb-3 flex items-center gap-1.5 text-sm font-semibold">
        <MessageSquare className="size-4 text-muted-foreground" />
        讨论 ({listQuery.data?.total ?? 0})
      </h2>

      <CommentInput
        placeholder={currentUserId ? '写下你的看法…' : '请先登录后参与讨论'}
        disabled={!currentUserId || createMut.isPending}
        onSubmit={async (body) => {
          await createMut.mutateAsync({ body });
        }}
      />

      {createMut.isError && (
        <p className="mt-2 text-xs text-destructive">{(createMut.error as Error).message}</p>
      )}

      {listQuery.isLoading && (
        <div className="mt-4 space-y-3">
          {[0, 1].map((i) => (
            <div key={i} className="flex gap-2.5">
              <Skeleton className="size-8 shrink-0 rounded-full" />
              <div className="flex-1 space-y-1.5">
                <Skeleton className="h-3 w-24" />
                <Skeleton className="h-3 w-full" />
              </div>
            </div>
          ))}
        </div>
      )}

      {listQuery.isError && (
        <p className="mt-4 text-sm text-destructive">{(listQuery.error as Error).message}</p>
      )}

      <div className="mt-4">
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
          <p className="py-4 text-sm text-muted-foreground">还没有评论，来抢沙发吧。</p>
        )}
      </div>
    </section>
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
    // group/comment 让 hover 才浮现操作按钮 —— 默认页面更安静
    <article className="group/comment border-b border-border py-3 last:border-b-0">
      <div className="flex gap-2.5">
        <Avatar user={comment.author} />
        <div className="min-w-0 flex-1">
          <div className="mb-1 flex flex-wrap items-center gap-2">
            <span className="text-sm font-semibold">{comment.author.name}</span>
            <span className="text-xs text-muted-foreground">
              {formatRelative(comment.createdAt)}
            </span>
            {comment.promoteStatus === 'approved' && (
              <span className="inline-flex items-center gap-1 rounded bg-radar-published-bg px-1.5 py-0.5 text-[10px] text-radar-published-fg">
                <Sparkles className="size-3" />
                已提炼为知识卡片
              </span>
            )}
            {comment.promoteStatus === 'rejected' && (
              <span className="rounded bg-radar-rejected-bg px-1.5 py-0.5 text-[10px] text-radar-rejected-fg">
                已拒绝提名
              </span>
            )}
          </div>

          <p className="whitespace-pre-wrap break-words text-sm leading-relaxed">{comment.body}</p>

          {/* 操作按钮 hover 才出现（mockup 风格） */}
          <div className="mt-1.5 flex items-center gap-1 opacity-0 transition-opacity duration-150 group-hover/comment:opacity-100 focus-within:opacity-100">
            <Button
              type="button"
              variant="ghost"
              size="xs"
              onClick={() => onStar(starred ? 'unstar' : 'star')}
              disabled={!currentUserId}
              className={cn(
                starred
                  ? 'text-amber-600 hover:text-amber-600'
                  : 'text-muted-foreground hover:text-amber-600',
              )}
              data-testid={`star-button-${comment.id}`}
            >
              <Star className={cn('size-3.5', starred && 'fill-current')} />
              {comment.starCount > 0 ? comment.starCount : '重要'}
            </Button>
            {currentUserId && (
              <Button
                type="button"
                variant="ghost"
                size="xs"
                className="text-muted-foreground"
                onClick={() => setReplyOpen((v) => !v)}
              >
                回复
              </Button>
            )}
            {canDelete && (
              <Button
                type="button"
                variant="ghost"
                size="xs"
                className="text-destructive hover:text-destructive"
                onClick={onDelete}
              >
                删除
              </Button>
            )}
          </div>

          {/* 回复输入框 */}
          {replyOpen && (
            <div className="mt-2">
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

          {/* 嵌套回复（仅 1 层） */}
          {comment.children.length > 0 && (
            <div className="ml-2 mt-2 border-l-2 border-border pl-3">
              {comment.children.slice(0, repliesExpanded ? undefined : 2).map((r) => (
                <div key={r.id} className="py-1.5">
                  <div className="mb-0.5 flex items-center gap-2">
                    <span className="text-xs font-semibold">{r.author.name}</span>
                    <span className="text-xs text-muted-foreground">
                      {formatRelative(r.createdAt)}
                    </span>
                  </div>
                  <p className="whitespace-pre-wrap break-words text-[13px] leading-relaxed text-muted-foreground">
                    {r.body}
                  </p>
                </div>
              ))}
              {!repliesExpanded && comment.childCount > comment.children.length && (
                <Button
                  type="button"
                  variant="link"
                  size="xs"
                  className="mt-1 h-auto p-0"
                  onClick={() => setRepliesExpanded(true)}
                >
                  查看全部 {comment.childCount} 条回复
                </Button>
              )}
            </div>
          )}
        </div>
      </div>
    </article>
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
      <Textarea
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
        className={cn('resize-y', small ? 'min-h-[56px] text-[13px]' : 'min-h-[72px]')}
      />
      {error && <p className="mt-1 text-xs text-destructive">{error}</p>}
      <div className="mt-1.5 flex justify-end gap-2">
        {onCancel && (
          <Button type="button" variant="outline" size="xs" onClick={onCancel}>
            取消
          </Button>
        )}
        <Button
          type="button"
          size="xs"
          onClick={submit}
          disabled={disabled || submitting || !body.trim()}
        >
          {submitting ? '发送中…' : '发送 (⌘+Enter)'}
        </Button>
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
    return (
      <img
        src={user.avatarUrl}
        alt={user.name}
        className="size-8 shrink-0 rounded-full object-cover"
      />
    );
  }
  const initial = user.name?.[0] ?? '?';
  const hue = hashHue(user.id);
  return (
    <div
      className="flex size-8 shrink-0 items-center justify-center rounded-full text-sm font-semibold text-white"
      // ⚠️ 全站唯一允许的内联颜色：色相由 user.id 运行时算出，无法 token 化。
      style={{ background: `hsl(${hue} 70% 45%)` }}
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
