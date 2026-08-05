'use client';

// 调研库详情页 —— 按 type 分支显示长文 / 精华布局。
//
// draft: 仅 owner 可见；显示「编辑」「发布」按钮
// published: 全员可见；owner / admin 可编辑（W3 canEdit 由服务端计算）
//
// type='research'（长文）：背景 → 正文 → 结论 → 风险 → research_sources 列表
// type='knowledge'（精华）：sourceComment 引用 → 短 body → 来源评论跳转
// W9：评论改为右下浮按钮 + Sheet 抽屉；正文 SectionCard 减少（仅保留 tone 区分手感）。
//
// 布局：max-w-measure（760px）—— 中文长文的舒适量度。

import { useState } from 'react';
import { useParams } from 'next/navigation';
import { useQuery } from '@tanstack/react-query';
import Link from 'next/link';

import { CommentSection } from '@/components/CommentSection';
import MarkdownContent from '@/components/MarkdownContent';
import { EmptyState } from '@/components/EmptyState';
import { MetaItem, MetaRow } from '@/components/domain/MetaRow';
import { SectionCard } from '@/components/domain/SectionCard';
import { StatusBadge } from '@/components/domain/StatusBadge';
import { TagChip, TagList } from '@/components/domain/TagChip';
import { Button } from '@/components/ui/button';
import { Sheet, SheetContent, SheetTitle } from '@/components/ui/sheet';
import { Skeleton } from '@/components/ui/skeleton';
import { useCurrentUser } from '@/lib/auth/client';
import {
  AlertTriangle,
  CalendarDays,
  CheckCircle2,
  ExternalLink,
  Info,
  Link2,
  MessageSquare,
  Pencil,
  User,
  Wand2,
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

  return (
    <div className="mx-auto max-w-measure">
      {/* 头部 */}
      <div className="mb-5 flex items-start justify-between gap-3">
        <div className="min-w-0">
          <nav className="mb-2 flex items-center gap-1.5 text-xs text-muted-foreground">
            <Link href="/researches" className="hover:text-foreground hover:underline">
              调研库
            </Link>
            <span>/</span>
            <span className="truncate">{data.title}</span>
          </nav>

          <h1 className="text-2xl font-semibold leading-tight tracking-tight">{data.title}</h1>

          <div className="mt-2 flex flex-wrap items-center gap-1.5">
            <span
              className={
                isLongResearch
                  ? 'rounded-full bg-status-running-bg px-2 py-0.5 text-xs font-medium text-status-running-fg'
                  : 'rounded-full bg-status-queued-bg px-2 py-0.5 text-xs font-medium text-status-queued-fg'
              }
            >
              {isLongResearch ? '长文' : '精华'}
            </span>
            <StatusBadge kind="method" value={data.creationMethod} />
            {data.aiAssisted && (
              <span className="inline-flex items-center gap-1 rounded-full border border-method-ai/40 px-2 py-0.5 text-xs text-method-ai">
                <Wand2 className="size-3" />
                AI 协助
              </span>
            )}
            {isDraft && <StatusBadge kind="research" value="draft" />}
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

        {data.canEdit && (
          <Button asChild variant="outline" size="sm" className="shrink-0">
            <Link href={`/researches/${data.id}/edit`}>
              <Pencil />
              编辑
            </Link>
          </Button>
        )}
      </div>

      {data.tags.length > 0 && (
        <TagList className="mb-5">
          {data.tags.map((t) => (
            <TagChip key={t}>{t}</TagChip>
          ))}
        </TagList>
      )}

      <div className="space-y-5">
        {/* ── 长文布局：background → body → conclusion → risks → research_sources ── */}
        {isLongResearch && (
          <>
            {data.background && (
              <SectionCard title="背景" tone="info" icon={Info}>
                <MarkdownContent content={data.background} compact={data.aiAssisted} />
              </SectionCard>
            )}

            <article className="py-2 sm:py-3" aria-label="正文">
              <MarkdownContent content={data.body} compact={data.aiAssisted} />
            </article>

            {data.conclusion && (
              <SectionCard title="结论" tone="success" icon={CheckCircle2}>
                <MarkdownContent content={data.conclusion} compact={data.aiAssisted} />
              </SectionCard>
            )}

            {data.risks && (
              <SectionCard title="风险" tone="destructive" icon={AlertTriangle}>
                <MarkdownContent content={data.risks} compact={data.aiAssisted} />
              </SectionCard>
            )}

            {/* research_sources：仅已发布长文挂载（draft 不展示） */}
            {data.status === 'published' && data.researchSources.length > 0 && (
              <section className="mt-6 border-t border-border pt-4">
                <h2 className="mb-2 flex items-center gap-1.5 text-xs font-medium uppercase tracking-wide text-muted-foreground">
                  <Link2 className="size-3.5" />
                  挂载资料 · {data.researchSources.length}
                </h2>
                <ul className="list-none divide-y divide-border p-0">
                  {data.researchSources.map((s) => {
                    const ref = (s.sourceRef ?? {}) as { type?: string; value?: string };
                    const href = sourceHrefForRef(ref);
                    return (
                      <li key={s.id} className="py-2.5 text-sm">
                        <div className="flex flex-wrap items-center gap-2">
                          <span className="rounded bg-accent px-1.5 py-0.5 font-mono text-[10px] font-medium text-accent-foreground">
                            {ref.type ?? 'unknown'}
                          </span>
                          {href ? (
                            <a
                              href={href}
                              target="_blank"
                              rel="noreferrer noopener"
                              className="inline-flex items-center gap-1 font-medium hover:text-primary hover:underline"
                            >
                              {s.title ?? ref.value ?? s.canonicalKey}
                              <ExternalLink className="size-3" />
                            </a>
                          ) : (
                            <span className="font-medium">{s.title ?? s.canonicalKey}</span>
                          )}
                        </div>
                        {s.description && (
                          <p className="mt-1 text-xs text-muted-foreground">{s.description}</p>
                        )}
                        <p className="mt-0.5 break-all font-mono text-xs text-muted-foreground">
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
                      查看原始{data.sourceComment.targetType === 'summary' ? '摘要' : '长文'}:{' '}
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

      {/* 评论：右下浮按钮 + Sheet 抽屉（仅已发布可见） */}
      {data.status === 'published' ? <CommentsFab researchId={data.id} commentCount={data.commentCount ?? 0} /> : null}
    </div>
  );
}

function CommentsFab({
  researchId,
  commentCount,
}: {
  researchId: string;
  commentCount: number;
}) {
  const me = useCurrentUser();
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button
        type="button"
        size="sm"
        onClick={() => setOpen(true)}
        aria-label={`打开讨论 · ${commentCount} 条`}
        className="fixed bottom-5 right-5 z-30 h-11 gap-2 rounded-full px-4 shadow-lg"
      >
        <MessageSquare className="size-4" />
        讨论
        {commentCount > 0 ? (
          <span className="rounded-full bg-primary-foreground/20 px-1.5 font-mono text-[11px] tabular-nums">
            {commentCount}
          </span>
        ) : null}
      </Button>
      <Sheet open={open} onOpenChange={setOpen}>
        <SheetContent
          side="right"
          className="flex w-full max-w-md flex-col gap-0 p-0 sm:max-w-md"
        >
          <SheetTitle className="flex h-topbar items-center gap-2 border-b border-border px-4 text-sm font-semibold">
            <MessageSquare className="size-4 text-muted-foreground" />
            讨论 · {commentCount} 条
          </SheetTitle>
          <div className="flex-1 overflow-y-auto px-4 py-4">
            <CommentSection
              targetType="research"
              targetId={researchId}
              currentUserId={me.data?.id ?? null}
              currentUserRole={me.data?.role ?? null}
            />
          </div>
        </SheetContent>
      </Sheet>
    </>
  );
}

function sourceHrefForRef(ref: { type?: string; value?: string }): string | null {
  if (!ref.value) return null;
  if (ref.type === 'url') return ref.value;
  if (ref.type === 'doi') return `https://doi.org/${ref.value}`;
  if (ref.type === 'arxiv') return `https://arxiv.org/abs/${ref.value}`;
  return null;
}
