'use client';

// 调研库详情页 —— 按 type 分支显示研究报告 / 知识卡片布局。
//
// draft: 仅 owner 可见；显示「编辑」「发布」按钮
// published: 全员可见；owner 可编辑，admin 仅可编辑已发布内容
// （W3 canEdit / canManageStatus 由服务端计算）
//
// type='research'（研究报告）：研究摘要 → 正文 → 参考文献由正文引用承担
// type='knowledge'（知识卡片）：sourceComment 引用 → 短 body → 来源评论跳转
// W9：评论使用右侧 Sheet 抽屉；正文 SectionCard 减少（仅保留 tone 区分手感）。
//
// 布局：max-w-measure（760px）—— 中文长文的舒适量度。

import { useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import Link from 'next/link';

import { CommentSection } from '@/components/CommentSection';
import MarkdownContent from '@/components/MarkdownContent';
import { EmptyState } from '@/components/EmptyState';
import { DeleteDraftButton } from '@/components/research/DeleteDraftButton';
import { ResearchStatusActionButton } from '@/components/research/ResearchStatusActionButton';
import { MetaItem, MetaRow } from '@/components/domain/MetaRow';
import { SectionCard } from '@/components/domain/SectionCard';
import { StatusBadge } from '@/components/domain/StatusBadge';
import { TagChip, TagList } from '@/components/domain/TagChip';
import { Button } from '@/components/ui/button';
import { Sheet, SheetContent, SheetTitle } from '@/components/ui/sheet';
import { Skeleton } from '@/components/ui/skeleton';
import { useCurrentUser } from '@/lib/auth/client';
import { BackToSearchButton } from '@/components/domain/BackToSearchButton';
import { cleanResearchMarkdown } from '@/lib/research-markdown-cleanup';
import {
  CalendarDays,
  Info,
  MessageSquare,
  Pencil,
  Star,
  User,
} from 'lucide-react';

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
  featuredAt: string | null;
  createdAt: string;
  updatedAt: string;
  author: { id: string; name: string };
  canEdit: boolean;
  canManageStatus: boolean;
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
  const queryClient = useQueryClient();
  const me = useCurrentUser();
  const [discussionOpen, setDiscussionOpen] = useState(false);

  const { data, isLoading, isError, error } = useQuery<ResearchDetail>({
    queryKey: ['research', params.id],
    queryFn: async () => {
      const res = await fetch(`/api/researches/${params.id}`);
      if (!res.ok) {
        if (res.status === 404) throw new Error('调研库不存在');
        throw new Error('加载失败');
      }
      return res.json();
    },
  });

  if (isLoading) {
    return (
      <div className="mx-auto max-w-measure space-y-3">
        <Skeleton className="h-4 w-32" />
        <Skeleton className="h-7 w-2/3" />
        <Skeleton className="h-4 w-48" />
        <Skeleton className="h-48 w-full" />
      </div>
    );
  }

  if (isError || !data) {
    return (
      <div className="mx-auto max-w-measure">
        <EmptyState
          title={error instanceof Error ? error.message : '调研库不存在'}
          action={
            <Button asChild variant="outline" size="sm">
              <Link href="/researches">返回列表</Link>
            </Button>
          }
        />
      </div>
    );
  }

  const isLongResearch = data.type === 'research';
  const isKnowledge = data.type === 'knowledge';
  const isDraft = data.status === 'draft';
  const isArchived = data.status === 'archived';

  return (
    <div className="mx-auto max-w-shell">
      {/* 头部 */}
      <div className="mb-5 flex items-start justify-between gap-3">
        <div className="min-w-0">
          <nav className="mb-2 flex items-center gap-1.5 text-xs text-muted-foreground">
            <BackToSearchButton />
            <Link href="/researches" className="hover:text-foreground hover:underline">
              调研库
            </Link>
            <span>/</span>
            <span className="truncate">{data.title}</span>
          </nav>

          <h1 className="text-2xl font-semibold leading-tight tracking-normal">{data.title}</h1>

          <div className="mt-2 flex flex-wrap items-center gap-1.5">
            <span
              className={
                isLongResearch
                  ? 'rounded-full bg-status-running-bg px-2 py-0.5 text-xs font-medium text-status-running-fg'
                  : 'rounded-full bg-status-queued-bg px-2 py-0.5 text-xs font-medium text-status-queued-fg'
              }
            >
              {isLongResearch ? '研究报告' : '知识卡片'}
            </span>
            <StatusBadge kind="method" value={data.creationMethod} />
            {isDraft && <StatusBadge kind="research" value="draft" />}
            {data.featuredAt && (
              <span className="inline-flex items-center gap-1 rounded-full border border-amber-400/60 bg-amber-400/10 px-2 py-0.5 text-xs font-medium text-amber-700 dark:text-amber-300">
                <Star className="size-3" />
                精华
              </span>
            )}
          </div>

          <MetaRow className="mt-2">
            <MetaItem icon={<User />}>{data.author.name}</MetaItem>
            <MetaItem icon={<CalendarDays />}>
              创建 {new Date(data.createdAt).toLocaleString('zh-CN')}
            </MetaItem>
            {data.publishedAt && (
              <MetaItem>发布 {new Date(data.publishedAt).toLocaleString('zh-CN')}</MetaItem>
            )}
            {data.commentCount !== undefined && (
              <MetaItem icon={<MessageSquare />}>{data.commentCount}</MetaItem>
            )}
          </MetaRow>
        </div>

        {data.canEdit || data.canManageStatus ? (
          <div className="flex shrink-0 items-center gap-2">
            {isDraft && data.canEdit ? (
              <DeleteDraftButton
                researchId={data.id}
                title={data.title}
                onDeleted={() => {
                  router.replace('/researches?tab=draft');
                  router.refresh();
                }}
              />
            ) : null}
            {!isDraft && data.canManageStatus && (
              <ResearchStatusActionButton
                researchId={data.id}
                title={data.title}
                status={isArchived ? 'archived' : 'published'}
                onChanged={() => {
                  queryClient.invalidateQueries({ queryKey: ['research', data.id] });
                  queryClient.invalidateQueries({ queryKey: ['researches'] });
                  router.refresh();
                }}
              />
            )}
            {data.canEdit && (
              <Button asChild variant="outline" size="sm">
                <Link href={`/researches/${data.id}/edit`}>
                  <Pencil />
                  编辑
                </Link>
              </Button>
            )}
          </div>
        ) : null}
      </div>

      {data.tags.length > 0 && (
        <TagList className="mb-5">
          {data.tags.map((t) => (
            <TagChip key={t}>{t}</TagChip>
          ))}
        </TagList>
      )}

      <div className="grid gap-8 lg:grid-cols-[minmax(0,760px)_240px] lg:items-start">
      <div className="min-w-0 space-y-5">
        {/* ── 长文布局：研究摘要 → 正文；参考文献由正文引用承担 ── */}
        {isLongResearch && (
          <>
            {(data.background || data.conclusion || data.risks) && (
              <SectionCard title="研究摘要" tone="default" icon={Info}>
                <div className="space-y-3">
                  {data.background && <div className="rounded-md border border-status-running-fg/25 bg-status-running-bg/35 p-3"><h2 className="mb-1 text-sm font-medium text-status-running-fg">背景</h2><MarkdownContent content={data.background} compact={data.aiAssisted} /></div>}
                  {data.conclusion && <div className="rounded-md border border-status-succeeded-fg/25 bg-status-succeeded-bg/35 p-3"><h2 className="mb-1 text-sm font-medium text-status-succeeded-fg">结论</h2><MarkdownContent content={data.conclusion} compact={data.aiAssisted} /></div>}
                  {data.risks && <div className="rounded-md border border-status-failed-fg/25 bg-status-failed-bg/35 p-3"><h2 className="mb-1 text-sm font-medium text-status-failed-fg">风险与待验证项</h2><MarkdownContent content={data.risks} compact={data.aiAssisted} /></div>}
                </div>
              </SectionCard>
            )}

            <article className="py-2 sm:py-3" aria-label="正文">
              <MarkdownContent content={cleanResearchMarkdown(data.body)} compact={data.aiAssisted} />
            </article>

          </>
        )}

        {/* ── 精华布局：sourceComment 引用 + 短 body + 来源评论跳转 ── */}
        {isKnowledge && (
          <>
            {data.sourceComment && (
              <SectionCard title="来源评论" tone="accent">
                <blockquote className="rounded-md border border-border bg-card px-3 py-2 text-sm leading-relaxed">
                  {data.sourceComment.body}
                </blockquote>
                <div className="mt-2 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                  <span>by {data.sourceComment.authorName}</span>
                  {data.sourceComment.targetId && (
                    <Link
                      href={
                        data.sourceComment.targetType === 'summary'
                          ? `/summaries/${data.sourceComment.targetId}`
                          : `/researches/${data.sourceComment.targetId}`
                      }
                      className="text-primary hover:underline"
                    >
                      查看原始{data.sourceComment.targetType === 'summary' ? '摘要' : '研究报告'}:{' '}
                      {data.sourceComment.targetTitle ?? '...'}
                    </Link>
                  )}
                </div>
              </SectionCard>
            )}

            <SectionCard title="正文">
              <MarkdownContent content={data.body} compact={data.aiAssisted} />
            </SectionCard>

            {data.background && (
              <SectionCard title="背景">
                <MarkdownContent content={data.background} compact={data.aiAssisted} />
              </SectionCard>
            )}

            {data.conclusion && (
              <SectionCard title="结论">
                <MarkdownContent content={data.conclusion} compact={data.aiAssisted} />
              </SectionCard>
            )}
          </>
        )}
      </div>

      <aside className="space-y-3 lg:sticky lg:top-[72px]">
        <section className="rounded-lg border border-border bg-card p-4">
          <h2 className="mb-3 text-[11px] font-semibold uppercase tracking-[0.12em] text-muted-foreground">证据卡</h2>
          <dl className="grid gap-3 text-xs">
            <div><dt className="text-muted-foreground">状态</dt><dd className="mt-0.5 font-medium">{isDraft ? '草稿' : data.status === 'published' ? '已发布' : '已归档'}</dd></div>
            <div><dt className="text-muted-foreground">作者</dt><dd className="mt-0.5 font-medium">{data.author.name}</dd></div>
            <div><dt className="text-muted-foreground">更新时间</dt><dd className="mt-0.5 font-mono text-[11px]">{new Date(data.updatedAt).toISOString().slice(0, 10)}</dd></div>
            <div><dt className="text-muted-foreground">内容类型</dt><dd className="mt-0.5 font-medium">{isLongResearch ? '研究报告' : '知识卡片'}</dd></div>
          </dl>
        </section>
        {data.status === 'published' ? (
          <section className="rounded-lg border border-border bg-card p-4">
            <h2 className="mb-1 text-[11px] font-semibold uppercase tracking-[0.12em] text-muted-foreground">团队讨论</h2>
            <p className="text-xs leading-relaxed text-muted-foreground">发布后可在这里查看评论、回复并继续协作。</p>
            <Button type="button" variant="outline" size="sm" className="mt-3 w-full" onClick={() => setDiscussionOpen(true)}>
              <MessageSquare className="size-3.5" />
              打开讨论
            </Button>
          </section>
        ) : null}
      </aside>
      </div>

      {/* 审计历史 */}
      {data.audits && data.audits.length > 0 && (
        <details className="mt-5 rounded-lg border border-border bg-card p-3">
          <summary className="cursor-pointer text-sm font-medium text-muted-foreground">
            修改历史 ({data.audits.length})
          </summary>
          <div className="mt-2 divide-y divide-border">
            {data.audits.map((a) => (
              <div key={a.id} className="py-2 text-xs text-muted-foreground">
                <span className="font-medium text-foreground">
                  {a.action === 'create'
                    ? '创建'
                    : a.action === 'edit'
                      ? '编辑'
                      : a.action === 'publish'
                    ? '发布'
                    : a.action === 'archive'
                      ? '归档'
                      : a.action === 'restore'
                        ? '恢复'
                        : a.action === 'feature'
                          ? '设为精华'
                          : a.action === 'unfeature'
                            ? '取消精华'
                    : a.action}
                </span>{' '}
                by {a.editor.name} at {new Date(a.createdAt).toLocaleString('zh-CN')}
                {a.diff &&
                typeof a.diff === 'object' &&
                Object.keys(a.diff as Record<string, unknown>).length > 0 ? (
                  <span> （{Object.keys(a.diff as Record<string, unknown>).join(', ')} 变更）</span>
                ) : null}
              </div>
            ))}
          </div>
        </details>
      )}

      {data.status === 'published' ? (
        <Sheet open={discussionOpen} onOpenChange={setDiscussionOpen}>
          <SheetContent side="right" className="flex w-full max-w-md flex-col gap-0 p-0 sm:max-w-md">
            <SheetTitle className="flex h-topbar items-center gap-2 border-b border-border px-4 text-sm font-semibold">
              <MessageSquare className="size-4 text-muted-foreground" />
              讨论 · {data.commentCount ?? 0} 条
            </SheetTitle>
            <div className="flex-1 overflow-y-auto px-4 py-4">
              <CommentSection targetType="research" targetId={data.id} currentUserId={me.data?.id ?? null} currentUserRole={me.data?.role ?? null} content={data.body} />
            </div>
          </SheetContent>
        </Sheet>
      ) : null}
    </div>
  );
}
