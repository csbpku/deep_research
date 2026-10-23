'use client';

// 评论组件：列表 + 输入 + 嵌套回复 + 点赞 + 删除。
//
// 契约源：
//   - /api/summaries/[id]/comments（雷达摘要兼容路径）或 /api/researches/[id]/comments
//   - /api/comments/[id]/star、/api/comments/[id]、/api/comments/my-stars
//
// 设计：
//   - top-level 评论按 createdAt desc 排序；嵌套 1 层（避免无限线程）
//   - 一人一票（CommentStar @@unique）
//   - 作者可删除自己；admin 可删除任意评论
//
// ⚠️ e2e 契约：data-testid="comment-section"、data-testid={`star-button-${id}`}

import React, { useEffect, useRef, useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Check, Lightbulb, MessageSquare, Sparkles, Star } from 'lucide-react';
import Alert from '@mui/material/Alert';
import MuiAvatar from '@mui/material/Avatar';
import Box from '@mui/material/Box';
import Chip from '@mui/material/Chip';
import ListItemButton from '@mui/material/ListItemButton';
import Paper from '@mui/material/Paper';
import Popper from '@mui/material/Popper';
import Skeleton from '@mui/material/Skeleton';
import Stack from '@mui/material/Stack';
import Typography from '@mui/material/Typography';
import { space, tokens } from '@deep-research/design-system';

import { AppButton as Button } from '@/components/material/AppButton';
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
const compactActionSx = {
  minHeight: '32px',
  paddingInline: space.sm,
  '@media (pointer:coarse)': { minHeight: 'var(--dr-touch-target)' },
} as const;

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
    <Paper component="section" variant="outlined" className="material-surface" data-testid="comment-section" sx={{
      minWidth: 0, mt: compact ? 0 : space.md, padding: compact ? space.md : space.lg,
      borderRadius: tokens['radius-medium'],
    }}>
      <Stack component="header" direction="row" spacing={space.sm} sx={{ alignItems: 'center', marginBottom: space.md }}>
        <MessageSquare size={18} aria-hidden="true" color="var(--dr-color-text-secondary)" />
        <Typography component="h2" variant="control" sx={{ fontWeight: 600 }}>
          讨论 ({listQuery.data?.total ?? 0})
        </Typography>
      </Stack>

      {anchor && (
        <Box sx={{ marginBottom: space.md, padding: space.md, border: 1, borderColor: 'divider', borderRadius: tokens['radius-small'], bgcolor: 'action.hover' }}>
          <Typography variant="metadata" sx={{ fontWeight: 500, color: 'text.primary' }}>针对选中文本</Typography>
          <Typography variant="body2" color="text.secondary" sx={{ marginTop: space.xs, display: '-webkit-box', WebkitLineClamp: 3, WebkitBoxOrient: 'vertical', overflow: 'hidden', whiteSpace: 'pre-wrap' }}>
            “{anchor.quote}”
          </Typography>
        </Box>
      )}

      <CommentInput
        placeholder={currentUserId ? '写下你的看法… 输入 @ 提及成员' : '请先登录后参与讨论'}
        disabled={!currentUserId || createMut.isPending}
        onSubmit={async (body, mentionedUserIds) => {
          await createMut.mutateAsync({ body, mentionedUserIds, anchor });
        }}
      />

      {createMut.isError && <Alert severity="error" sx={{ marginTop: space.sm, py: 0 }}>{(createMut.error as Error).message}</Alert>}

      {listQuery.isLoading && (
        <Stack spacing={space.md} sx={{ marginTop: space.lg }} role="status" aria-label="正在加载讨论">
          {[0, 1].map((i) => (
            <Stack key={i} direction="row" spacing={space.sm}>
              <Skeleton variant="circular" width={32} height={32} />
              <Box sx={{ flex: 1, minWidth: 0 }}>
                <Skeleton width="6rem" height={20} />
                <Skeleton width="100%" height={20} />
              </Box>
            </Stack>
          ))}
        </Stack>
      )}

      {listQuery.isError && <Alert severity="error" sx={{ marginTop: space.lg }}>{(listQuery.error as Error).message}</Alert>}

      <Box sx={{ marginTop: space.lg }}>
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
      </Box>
    </Paper>
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
    <Box component="article" sx={{
      minWidth: 0, paddingBlock: space.md, borderBottom: 1, borderColor: 'divider',
      '&:last-of-type': { borderBottom: 0 },
      '@media (min-width:640px) and (hover:hover) and (pointer:fine)': {
        '& [data-comment-actions]': { opacity: 0, transition: 'opacity var(--dr-motion-fast)' },
        '&:hover [data-comment-actions], &:focus-within [data-comment-actions]': { opacity: 1 },
      },
    }}>
      <Stack direction="row" spacing={space.sm} sx={{ alignItems: 'flex-start' }}>
        <CommentAvatar user={comment.author} />
        <Box sx={{ minWidth: 0, flex: 1 }}>
          <Stack direction="row" spacing={space.sm} useFlexGap sx={{ flexWrap: 'wrap', alignItems: 'center', marginBottom: space.xs }}>
            <Typography variant="control" sx={{ fontWeight: 600, overflowWrap: 'anywhere' }}>{comment.author.name}</Typography>
            <Typography variant="metadata" color="text.secondary">{formatRelative(comment.createdAt)}</Typography>
            {comment.promoteStatus === 'approved' && (
              <Chip size="small" icon={<Sparkles size={14} aria-hidden="true" />} label="已提炼为知识卡片" sx={{ color: 'success.main', bgcolor: 'var(--dr-color-success-container)' }} />
            )}
            {comment.promoteStatus === 'nominated' && (
              <Chip size="small" icon={<Lightbulb size={14} aria-hidden="true" />} label="待提炼" sx={{ color: 'primary.main', bgcolor: 'primary.light' }} />
            )}
            {comment.promoteStatus === 'rejected' && (
              <Chip size="small" label="暂不提炼" sx={{ color: 'text.secondary', bgcolor: 'action.hover' }} />
            )}
          </Stack>

          <CommentBody body={comment.body} mentions={comment.mentions} />

          {comment.anchor ? (
            <Box sx={{ marginTop: space.sm, padding: space.md, border: 1, borderColor: 'divider', borderRadius: tokens['radius-small'], bgcolor: 'action.hover' }}>
              <Typography variant="metadata" sx={{ fontWeight: 500 }}>引用原文</Typography>
              <Typography variant="body2" color="text.secondary" sx={{ marginTop: space.xs, display: '-webkit-box', WebkitLineClamp: 3, WebkitBoxOrient: 'vertical', overflow: 'hidden', whiteSpace: 'pre-wrap' }}>
                “{comment.anchor.quote}”
              </Typography>
              {anchorStale ? <Typography variant="metadata" color="warning.main" sx={{ display: 'block', marginTop: space.xs }}>引用位置可能已失效，正文已发生变化。</Typography> : null}
            </Box>
          ) : null}

          <Box data-comment-actions sx={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: space.xs, marginTop: space.xs }}>
            <Button
              type="button"
              variant="text"
              size="small"
              onClick={() => onStar(starred ? 'unstar' : 'star')}
              disabled={!currentUserId}
              aria-pressed={starred}
              sx={{ ...compactActionSx, color: starred ? 'warning.main' : 'text.secondary', '&:hover': { color: 'warning.main' } }}
              data-testid={`star-button-${comment.id}`}
            >
              <Star size={16} aria-hidden="true" fill={starred ? 'currentColor' : 'none'} />
              {comment.starCount > 0 ? comment.starCount : '重要'}
            </Button>
            {currentUserId && (
              <Button type="button" variant="text" size="small" sx={compactActionSx} onClick={() => setReplyOpen((v) => !v)}>
                回复
              </Button>
            )}
            {currentUserId && comment.promoteStatus === 'none' && (
              <Button type="button" variant="text" size="small" sx={compactActionSx} onClick={onNominate} disabled={nominating}>
                <Lightbulb size={16} aria-hidden="true" />
                {nominating ? '提交中…' : '提议沉淀'}
              </Button>
            )}
            {canDelete && (
              <Button type="button" variant="text" size="small" color="error" sx={compactActionSx} onClick={onDelete}>
                删除
              </Button>
            )}
          </Box>

          {replyOpen && (
            <Box sx={{ marginTop: space.sm }}>
              <CommentInput
                placeholder={`回复 ${comment.author.name}… 输入 @ 提及成员`}
                small
                onSubmit={async (body, mentionedUserIds) => {
                  await onReply(body, mentionedUserIds);
                  setReplyOpen(false);
                }}
                onCancel={() => setReplyOpen(false)}
              />
            </Box>
          )}

          {comment.children.length > 0 && (
            <Box component="section" aria-label={`${comment.author.name}的回复`} sx={{ marginTop: space.sm, marginLeft: space.sm, paddingLeft: space.md, borderLeft: 2, borderColor: 'divider' }}>
              {comment.children.slice(0, repliesExpanded ? undefined : 2).map((r) => (
                <Box key={r.id} sx={{ paddingBlock: space.xs }}>
                  <Stack direction="row" spacing={space.sm} sx={{ marginBottom: '2px' }}>
                    <Typography variant="metadata" sx={{ fontWeight: 600 }}>{r.author.name}</Typography>
                    <Typography variant="metadata" color="text.secondary">{formatRelative(r.createdAt)}</Typography>
                  </Stack>
                  <CommentBody body={r.body} mentions={r.mentions} reply />
                </Box>
              ))}
              {!repliesExpanded && comment.childCount > comment.children.length && (
                <Button type="button" variant="text" size="small" sx={{ ...compactActionSx, paddingInline: 0 }} onClick={() => setRepliesExpanded(true)}>
                  查看全部 {comment.childCount} 条回复
                </Button>
              )}
            </Box>
          )}
        </Box>
      </Stack>
    </Box>
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
  const bodySx = { whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', color: reply ? 'text.secondary' : 'text.primary' } as const;
  if (names.length === 0) {
    return <Typography component="p" variant="body2" sx={bodySx}>{body}</Typography>;
  }
  const escaped = names.map((name) => name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  const parts = body.split(new RegExp(`(@(?:${escaped.join('|')}))`, 'g'));
  return (
    <Typography component="p" variant="body2" sx={bodySx}>
      {parts.map((part, index) => names.some((name) => part === `@${name}`)
        ? <Typography key={`${part}-${index}`} component="span" variant="inherit" sx={{ fontWeight: 500, color: 'primary.main' }}>{part}</Typography>
        : part)}
    </Typography>
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
  const inputRef = useRef<HTMLTextAreaElement>(null);

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
    <Box sx={{ position: 'relative', minWidth: 0 }}>
      <Box
        component="textarea"
        ref={inputRef}
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
        aria-label="评论内容，输入 @ 可选择团队成员"
        sx={{
          display: 'block', boxSizing: 'border-box', width: '100%', minHeight: small ? '56px' : '72px',
          resize: 'vertical', padding: space.sm, border: 1, borderColor: 'var(--dr-color-outline-strong)',
          borderRadius: tokens['radius-small'], bgcolor: 'background.paper', color: 'text.primary',
          fontFamily: 'inherit', fontSize: tokens['type-body'], lineHeight: tokens['line-height-body'],
          '&::placeholder': { color: 'text.disabled', opacity: 1 },
          '&:disabled': { cursor: 'not-allowed', opacity: 0.6 },
        }}
      />
      {mentionOpen && (
        <Popper
          open={mentionOpen}
          anchorEl={inputRef.current}
          placement="bottom-start"
          modifiers={[{ name: 'flip' }, { name: 'preventOverflow', options: { padding: 8 } }]}
          sx={(theme) => ({ zIndex: theme.zIndex.tooltip, width: inputRef.current?.getBoundingClientRect().width })}
        >
          <Paper component="div" variant="outlined" role="listbox" aria-label="选择要提及的成员" aria-multiselectable="true" sx={{ maxHeight: '14rem', overflowY: 'auto', padding: space.xs, boxShadow: tokens['elevation-2'] }}>
            {membersQuery.isLoading ? <Typography role="status" variant="metadata" color="text.secondary" sx={{ padding: space.sm }}>正在查找成员…</Typography> : null}
            {membersQuery.data?.items.map((member) => {
              const selected = selectedMembers.some((item) => item.id === member.id);
              return (
                <ListItemButton
                  key={member.id}
                  component="button"
                  type="button"
                  role="option"
                  aria-selected={selected}
                  selected={selected}
                  onMouseDown={(event) => event.preventDefault()}
                  onClick={() => selectMember(member)}
                  sx={{ minHeight: '44px', gap: space.sm, paddingInline: space.sm, paddingBlock: space.xs, textAlign: 'left' }}
                >
                  <CommentAvatar user={member} />
                  <Box sx={{ minWidth: 0, flex: 1 }}>
                    <Typography variant="control" sx={{ display: 'block', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{member.name}</Typography>
                    {member.email ? <Typography variant="metadata" color="text.secondary" sx={{ display: 'block', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{member.email}</Typography> : null}
                  </Box>
                  {selected ? <Check size={16} aria-hidden="true" color="var(--dr-color-primary)" /> : null}
                </ListItemButton>
              );
            })}
            {!membersQuery.isLoading && membersQuery.data?.items.length === 0 ? (
              <Typography variant="metadata" color="text.secondary" sx={{ display: 'block', padding: space.sm }}>没有匹配的成员</Typography>
            ) : null}
          </Paper>
        </Popper>
      )}
      {error && <Alert severity="error" sx={{ marginTop: space.xs, py: 0 }}>{error}</Alert>}
      <Stack direction="row" spacing={space.sm} sx={{ alignItems: 'center', justifyContent: 'space-between', marginTop: space.xs }}>
        <Typography variant="metadata" color="text.secondary" sx={{ fontFamily: 'monospace', fontVariantNumeric: 'tabular-nums' }}>
          {body.length}/{COMMENT_BODY_LIMIT}
        </Typography>
        <Stack direction="row" spacing={space.sm}>
          {onCancel && <Button type="button" variant="outlined" size="small" onClick={onCancel}>取消</Button>}
          <Button
            type="button"
            variant="contained"
            size="small"
            aria-label="发布评论"
            onClick={submit}
            disabled={disabled || submitting || !body.trim()}
          >
            {submitting ? '发送中…' : '发送 (⌘+Enter)'}
          </Button>
        </Stack>
      </Stack>
    </Box>
  );
}

// ────────────────────────────────────────────────────────────
// 头像占位
// ────────────────────────────────────────────────────────────

function CommentAvatar({ user }: { user: CommentAuthor }) {
  const initial = user.name?.[0] ?? '?';
  const hue = hashHue(user.id);
  return (
    <MuiAvatar
      src={user.avatarUrl ?? undefined}
      alt={user.name}
      sx={{
        width: '32px', height: '32px', flexShrink: 0, fontSize: tokens['type-label'], fontWeight: 600,
        color: 'common.white',
        // 用户标识生成的色相是运行时身份色，不属于可共享语义 palette。
        bgcolor: `hsl(${hue} 70% 45%)`,
      }}
    >
      {initial}
    </MuiAvatar>
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
