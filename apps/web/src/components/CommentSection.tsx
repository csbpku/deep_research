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

import { useEffect, useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Check, Lightbulb, MessageSquare, Sparkles, Star } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { Skeleton } from '@/components/ui/skeleton';
import { Avatar as AvatarRoot, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import { cn } from '@/lib/utils';
import { sha256Hex } from '@/lib/text-anchor';

interface CommentAuthor {
  id: string;
  name: string;
  avatarUrl: string | null;
}

interface MentionedMember extends CommentAuthor {
  email?: string;
}

interface ReplyItem {
  id: string;
  body: string;
  starCount: number;
  createdAt: string;
  author: CommentAuthor;
  mentions?: MentionedMember[];
}

interface CommentItem {
  id: string;
  body: string;
  parentId: string | null;
  starCount: number;
  promoteStatus: 'none' | 'nominated' | 'approved' | 'rejected';
  createdAt: string;
  author: CommentAuthor;
  mentions?: MentionedMember[];
  children: ReplyItem[];
  childCount: number;
  anchor?: CommentAnchor | null;
}

export interface CommentAnchor {
  quote: string;
  startOffset: number;
  endOffset: number;
  contentHash: string;
}

interface CommentListResponse {
  page: number;
  perPage: number;
  total: number;
  totalPages: number;
  items: CommentItem[];
}

const COMMENT_BODY_LIMIT = 2000;
const COMMENT_MENTION_LIMIT = 10;

export interface CommentSectionProps {
  /** 'summary' or 'research' */
  targetType: 'summary' | 'research';
  /** 目标 id（summary.id 或 research.id） */
  targetId: string;
  /** 当前登录用户 id（用于显示"删除"按钮）；null = 未登录 */
  currentUserId?: string | null;
  /** 当前用户角色 */
  currentUserRole?: 'member' | 'admin' | null;
  /** Optional selection anchor used by the editor's right-rail comments. */
  anchor?: CommentAnchor | null;
  /** Current article body, used to warn when a saved quote no longer matches. */
  content?: string;
  compact?: boolean;
}

export function CommentSection({
  targetType,
  targetId,
  currentUserId = null,
  currentUserRole = null,
  anchor = null,
  content,
  compact = false,
}: CommentSectionProps) {
  const queryClient = useQueryClient();
  const commentsKey = ['comments', targetType, targetId] as const;
  const [contentHash, setContentHash] = useState<string>();

  useEffect(() => {
    if (content === undefined) {
      setContentHash(undefined);
      return;
    }
    let active = true;
    void sha256Hex(content).then((hash) => {
      if (active) setContentHash(hash);
    });
    return () => { active = false; };
  }, [content]);

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
    mutationFn: async (input: { body: string; parentId?: string; mentionedUserIds: string[]; anchor?: CommentAnchor | null }) => {
      const { anchor, ...rest } = input;
      const r = await fetch(`/api/${targetType === 'summary' ? 'summaries' : 'researches'}/${targetId}/comments`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ ...rest, ...(anchor ? { anchor } : {}) }),
      });
      if (!r.ok) {
        const err = await r.json().catch(() => ({ message: '发送失败' })) as {
          message?: string;
          details?: { fieldErrors?: Record<string, string[]> };
        };
        const fieldError = err.details?.fieldErrors
          ? Object.values(err.details.fieldErrors).flat()[0]
          : undefined;
        throw new Error(fieldError ?? err.message ?? '发送失败');
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

  const nominateMut = useMutation({
    mutationFn: async (commentId: string) => {
      const r = await fetch(`/api/comments/${commentId}/nominate`, { method: 'POST' });
      if (!r.ok) {
        const err = await r.json().catch(() => ({ message: '提议失败' }));
        throw new Error(err.message ?? '提议失败');
      }
      return r.json() as Promise<{ promoteStatus: CommentItem['promoteStatus'] }>;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: commentsKey });
      queryClient.invalidateQueries({ queryKey: ['admin-comments'] });
      queryClient.invalidateQueries({ queryKey: ['admin-dashboard'] });
    },
  });

  return (
    <section
      className={cn(compact ? 'rounded-md border border-border bg-card p-3' : 'mt-4 rounded-md border border-border bg-card p-4')}
      data-testid="comment-section"
    >
      <h2 className="mb-3 flex items-center gap-1.5 text-sm font-semibold">
        <MessageSquare className="size-4 text-muted-foreground" />
        讨论 ({listQuery.data?.total ?? 0})
      </h2>

      {anchor && (
        <div className="mb-3 rounded border border-border bg-muted/30 p-2.5 text-xs text-muted-foreground">
          <span className="font-medium text-foreground">针对选中文本</span>
          <p className="mt-1 line-clamp-3 leading-relaxed">“{anchor.quote}”</p>
        </div>
      )}

      <CommentInput
        placeholder={currentUserId ? '写下你的看法… 输入 @ 提及成员' : '请先登录后参与讨论'}
        disabled={!currentUserId || createMut.isPending}
        onSubmit={async (body, mentionedUserIds) => {
          await createMut.mutateAsync({ body, mentionedUserIds, anchor });
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
            onNominate={() => nominateMut.mutate(c.id)}
            nominating={nominateMut.isPending && nominateMut.variables === c.id}
            onReply={async (body, mentionedUserIds) => {
              await createMut.mutateAsync({ body, parentId: c.id, mentionedUserIds });
            }}
            content={content}
            contentHash={contentHash}
          />
        ))}
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
  onNominate,
  nominating,
  onReply,
  content,
  contentHash,
}: {
  comment: CommentItem;
  isAuthor: boolean;
  isAdmin: boolean;
  currentUserId: string | null;
  starred: boolean;
  onStar: (action: 'star' | 'unstar') => void;
  onDelete: () => void;
  onNominate: () => void;
  nominating: boolean;
  onReply: (body: string, mentionedUserIds: string[]) => Promise<void>;
  content?: string;
  contentHash?: string;
}) {
  const [replyOpen, setReplyOpen] = useState(false);
  const [repliesExpanded, setRepliesExpanded] = useState(false);
  const canDelete = isAuthor || isAdmin;
  const anchorStale = comment.anchor ? isCommentAnchorStale(comment.anchor, content, contentHash) : false;

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
            {comment.promoteStatus === 'nominated' && (
              <span className="inline-flex items-center gap-1 rounded bg-accent px-1.5 py-0.5 text-[10px] text-accent-foreground">
                <Lightbulb className="size-3" />
                待提炼
              </span>
            )}
            {comment.promoteStatus === 'rejected' && (
              <span className="rounded bg-radar-rejected-bg px-1.5 py-0.5 text-[10px] text-radar-rejected-fg">
                暂不提炼
              </span>
            )}
          </div>

          <CommentBody body={comment.body} mentions={comment.mentions} />

          {comment.anchor ? (
            <div className="mt-2 rounded border border-border/70 bg-muted/25 px-2.5 py-2 text-xs text-muted-foreground">
              <div className="font-medium text-foreground">引用原文</div>
              <p className="mt-1 line-clamp-3 leading-relaxed">“{comment.anchor.quote}”</p>
              {anchorStale ? <p className="mt-1 text-status-warning-fg">引用位置可能已失效，正文已发生变化。</p> : null}
            </div>
          ) : null}

          {/* 操作按钮 hover 才出现（mockup 风格） */}
          <div className="mt-1.5 flex items-center gap-1 opacity-100 transition-opacity duration-150 sm:opacity-0 sm:group-hover/comment:opacity-100 sm:focus-within:opacity-100">
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
            {currentUserId && comment.promoteStatus === 'none' && (
              <Button
                type="button"
                variant="ghost"
                size="xs"
                className="text-muted-foreground hover:text-primary"
                onClick={onNominate}
                disabled={nominating}
              >
                <Lightbulb className="size-3.5" />
                {nominating ? '提交中…' : '提议沉淀'}
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
                placeholder={`回复 ${comment.author.name}… 输入 @ 提及成员`}
                small
                onSubmit={async (body, mentionedUserIds) => {
                  await onReply(body, mentionedUserIds);
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
                  <CommentBody body={r.body} mentions={r.mentions} reply />
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

function isCommentAnchorStale(anchor: CommentAnchor, content?: string, currentHash?: string): boolean {
  if (content === undefined) return false;
  if (currentHash !== undefined && currentHash !== anchor.contentHash) return true;
  if (anchor.startOffset < 0 || anchor.endOffset > content.length || anchor.endOffset <= anchor.startOffset) return true;
  return content.slice(anchor.startOffset, anchor.endOffset).trim() !== anchor.quote.trim();
}

function CommentBody({ body, mentions = [], reply = false }: { body: string; mentions?: MentionedMember[]; reply?: boolean }) {
  const names = [...mentions].sort((a, b) => b.name.length - a.name.length).map((member) => member.name);
  if (names.length === 0) {
    return <p className={cn('whitespace-pre-wrap break-words leading-relaxed', reply ? 'text-[13px] text-muted-foreground' : 'text-sm')}>{body}</p>;
  }
  const escaped = names.map((name) => name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  const parts = body.split(new RegExp(`(@(?:${escaped.join('|')}))`, 'g'));
  return (
    <p className={cn('whitespace-pre-wrap break-words leading-relaxed', reply ? 'text-[13px] text-muted-foreground' : 'text-sm')}>
      {parts.map((part, index) => names.some((name) => part === `@${name}`)
        ? <span key={`${part}-${index}`} className="font-medium text-primary">{part}</span>
        : part)}
    </p>
  );
}

// ────────────────────────────────────────────────────────────
// 评论输入框（@成员 + Cmd/Ctrl+Enter 提交）
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
  onSubmit: (body: string, mentionedUserIds: string[]) => Promise<void>;
  small?: boolean;
  onCancel?: () => void;
}) {
  const [body, setBody] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [mentionOpen, setMentionOpen] = useState(false);
  const [mentionQuery, setMentionQuery] = useState('');
  const [selectedMembers, setSelectedMembers] = useState<MentionedMember[]>([]);

  const membersQuery = useQuery<{ items: MentionedMember[] }>({
    queryKey: ['team-members', mentionQuery],
    queryFn: async () => {
      const r = await fetch(`/api/team-members?q=${encodeURIComponent(mentionQuery)}`, { cache: 'no-store' });
      if (!r.ok) throw new Error('成员列表加载失败');
      return r.json();
    },
    enabled: mentionOpen && !disabled,
  });

  const updateBody = (value: string) => {
    setBody(value);
    const match = value.match(/(?:^|\s)@([^@\s]*)$/);
    if (match) {
      setMentionQuery(match[1] ?? '');
      setMentionOpen(true);
    } else {
      setMentionOpen(false);
    }
  };

  const selectMember = (member: MentionedMember) => {
    if (selectedMembers.length >= COMMENT_MENTION_LIMIT) {
      setError(`一次最多 @ ${COMMENT_MENTION_LIMIT} 位成员`);
      return;
    }
    const match = body.match(/(?:^|\s)@([^@\s]*)$/);
    const nextBody = match
      ? `${body.slice(0, match.index)}${match[0].startsWith(' ') ? ' ' : ''}@${member.name} `
      : `${body}${body && !body.endsWith(' ') ? ' ' : ''}@${member.name} `;
    setBody(nextBody);
    setSelectedMembers((current) => current.some((item) => item.id === member.id) ? current : [...current, member]);
    setMentionOpen(false);
    setMentionQuery('');
  };

  const submit = async () => {
    const trimmed = body.trim();
    if (!trimmed) return;
    if (trimmed.length > COMMENT_BODY_LIMIT) {
      setError(`评论最多 ${COMMENT_BODY_LIMIT} 字`);
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      const mentionedUserIds = selectedMembers
        .filter((member) => trimmed.includes(`@${member.name}`))
        .map((member) => member.id);
      await onSubmit(trimmed, mentionedUserIds);
      setBody('');
      setSelectedMembers([]);
    } catch (err) {
      setError(err instanceof Error ? err.message : '发送失败');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="relative">
      <Textarea
        value={body}
        onChange={(e) => updateBody(e.target.value)}
        onKeyDown={(e) => {
          if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
            e.preventDefault();
            submit();
          }
        }}
        placeholder={placeholder}
        disabled={disabled}
        rows={small ? 2 : 3}
        maxLength={COMMENT_BODY_LIMIT}
        className={cn('resize-y', small ? 'min-h-[56px] text-[13px]' : 'min-h-[72px]')}
        aria-label="评论内容，输入 @ 可选择团队成员"
      />
      {mentionOpen && (
        <div className="absolute inset-x-0 top-full z-20 mt-1 max-h-56 overflow-y-auto rounded-md border border-border bg-popover p-1 shadow-lg" role="listbox" aria-label="选择要提及的成员">
          {membersQuery.isLoading ? <p className="px-2 py-2 text-xs text-muted-foreground">正在查找成员…</p> : null}
          {membersQuery.data?.items.map((member) => {
            const selected = selectedMembers.some((item) => item.id === member.id);
            return (
              <button
                key={member.id}
                type="button"
                role="option"
                aria-selected={selected}
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => selectMember(member)}
                className="flex w-full items-center gap-2 rounded-sm px-2 py-2 text-left hover:bg-accent focus-visible:bg-accent focus-visible:outline-none"
              >
                <Avatar user={member} />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm font-medium">{member.name}</span>
                  {member.email ? <span className="block truncate text-xs text-muted-foreground">{member.email}</span> : null}
                </span>
                {selected ? <Check className="size-4 text-primary" /> : null}
              </button>
            );
          })}
          {!membersQuery.isLoading && membersQuery.data?.items.length === 0 ? (
            <p className="px-2 py-2 text-xs text-muted-foreground">没有匹配的成员</p>
          ) : null}
        </div>
      )}
      {error && <p className="mt-1 text-xs text-destructive">{error}</p>}
      <div className="mt-1.5 flex items-center justify-between gap-2">
        <span className="font-mono text-[10px] tabular-nums text-muted-foreground">
          {body.length}/{COMMENT_BODY_LIMIT}
        </span>
        <div className="ml-auto flex justify-end gap-2">
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
    </div>
  );
}

// ────────────────────────────────────────────────────────────
// 头像占位
// ────────────────────────────────────────────────────────────

function Avatar({ user }: { user: CommentAuthor }) {
  const [loaded, setLoaded] = useState(false);
  const initial = user.name?.[0] ?? '?';
  const hue = hashHue(user.id);
  return (
    <AvatarRoot className="size-8">
      {user.avatarUrl ? (
        <AvatarImage
          src={user.avatarUrl}
          alt={user.name}
          className={loaded ? undefined : 'opacity-0'}
          onLoad={() => setLoaded(true)}
          onError={() => setLoaded(false)}
        />
      ) : null}
      <AvatarFallback
        className={cn('text-sm font-semibold text-white', loaded && 'opacity-0')}
        // ⚠️ 全站唯一允许的内联颜色：色相由 user.id 运行时算出，无法 token 化。
        style={{ background: `hsl(${hue} 70% 45%)` }}
      >
        {initial}
      </AvatarFallback>
    </AvatarRoot>
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
export const __testing__ = { hashHue, formatRelative, isCommentAnchorStale };
