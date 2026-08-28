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
import { Sheet, SheetContent, SheetDescription, SheetTitle } from '@/components/ui/sheet';
import { Skeleton } from '@/components/ui/skeleton';
import { useCurrentUser } from '@/lib/auth/client';
import { BackToSearchButton } from '@/components/domain/BackToSearchButton';
import { cleanResearchMarkdown } from '@/lib/research-markdown-cleanup';
import {
  AlertTriangle,
  ArrowUpRight,
  CalendarDays,
  CheckCircle2,
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
            <StatusBadge kind="researchType" value={isLongResearch ? 'research' : 'knowledge'} />
            <StatusBadge kind="method" value={data.creationMethod} />
            {isDraft && <StatusBadge kind="research" value="draft" />}
            {data.featuredAt && <StatusBadge kind="featured" value="true" icon={<Star />} />}
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
                  {data.background && (
                    <SectionCard tone="info" icon={Info} title="背景" bodyClassName="text-sm">
                      <MarkdownContent content={data.background} compact={data.aiAssisted} />
                    </SectionCard>
                  )}
                  {data.conclusion && (
                    <SectionCard tone="success" icon={CheckCircle2} title="结论" bodyClassName="text-sm">
                      <MarkdownContent content={data.conclusion} compact={data.aiAssisted} />
                    </SectionCard>
                  )}
                  {data.risks && (
                    <SectionCard tone="destructive" icon={AlertTriangle} title="风险与待验证项" bodyClassName="text-sm">
                      <MarkdownContent content={data.risks} compact={data.aiAssisted} />
                    </SectionCard>
                  )}
                </div>
              </SectionCard>
            )}

            <SectionCard title="正文" bodyClassName="prose-compact">
              <MarkdownContent content={cleanResearchMarkdown(data.body)} compact={data.aiAssisted} />
            </SectionCard>

          </>
        )}

        {/* ── 精华布局：sourceComment 引用 + 短 body + 来源评论跳转 ── */}
        {isKnowledge && (
          <>
            {data.sourceComment && (
              <SectionCard title="来源评论" tone="accent">
                <blockquote className="border-l-2 border-l-accent-foreground/40 bg-accent/30 px-3 py-2 text-sm leading-relaxed">
                  {data.sourceComment.body}
                </blockquote>
                <div className="mt-2 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                  <span>来自 {data.sourceComment.authorName}</span>
                  {data.sourceComment.targetId && (
                    <Link
                      href={
                        data.sourceComment.targetType === 'summary'
                          ? `/radar/${data.sourceComment.targetId}`
                          : `/researches/${data.sourceComment.targetId}`
                      }
                      className="inline-flex items-center gap-0.5 text-primary hover:underline"
                    >
                      <ArrowUpRight className="size-3" />
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
              <SectionCard title="结论" tone="success" icon={CheckCircle2}>
                <MarkdownContent content={data.conclusion} compact={data.aiAssisted} />
              </SectionCard>
            )}

            {/* 风险字段:knowledge 布局也读 risks,字段对齐 research 布局 */}
            {data.risks && (
              <SectionCard title="风险与待验证项" tone="destructive" icon={AlertTriangle}>
                <MarkdownContent content={data.risks} compact={data.aiAssisted} />
              </SectionCard>
            )}
          </>
        )}
      </div>

      <aside className="space-y-3 lg:sticky lg:top-[72px]">
        <SectionCard title="证据卡" tone="muted" icon={Info}>
          {/* D5/D6:证据卡「内容类型」「更新时间」对齐 SectionCard tone="muted" 风格;
              顶部 MetaRow 已展示「作者/创建/发布/评论数」,证据卡不重复 */}
          <dl className="grid gap-3 text-xs">
            <div><dt className="text-muted-foreground">状态</dt><dd className="mt-0.5 font-medium">{isDraft ? '草稿' : data.status === 'published' ? '已发布' : '已归档'}</dd></div>
            <div><dt className="text-muted-foreground">内容类型</dt><dd className="mt-0.5 font-medium">{isLongResearch ? '研究报告' : '知识卡片'}</dd></div>
            <div><dt className="text-muted-foreground">更新时间</dt><dd className="mt-0.5 font-mono text-[11px]">{new Date(data.updatedAt).toISOString().slice(0, 10)}</dd></div>
          </dl>
        </SectionCard>
        {data.status === 'published' ? (
          <SectionCard
            title="团队讨论"
            tone="muted"
            icon={MessageSquare}
            actions={
              <Button type="button" variant="outline" size="sm" onClick={() => setDiscussionOpen(true)}>
                <MessageSquare className="size-3.5" />
                打开讨论
              </Button>
            }
          >
            <p className="text-xs leading-relaxed text-muted-foreground">发布后可在这里查看评论、回复并继续协作。</p>
          </SectionCard>
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
            <SheetDescription className="sr-only">
              针对这篇调研的团队讨论与回复
            </SheetDescription>
            <div className="flex-1 overflow-y-auto px-4 py-4">
              <CommentSection targetType="research" targetId={data.id} currentUserId={me.data?.id ?? null} currentUserRole={me.data?.role ?? null} content={data.body} />
            </div>
          </SheetContent>
        </Sheet>
      ) : null}
    </div>
  );
}
