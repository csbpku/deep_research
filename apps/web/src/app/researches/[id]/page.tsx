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

import { useEffect, useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import Link from 'next/link';
import Drawer from '@mui/material/Drawer';
import Box from '@mui/material/Box';
import IconButton from '@mui/material/IconButton';
import Skeleton from '@mui/material/Skeleton';
import Typography from '@mui/material/Typography';

import { CommentSection } from '@/components/CommentSection';
import MarkdownContent from '@/components/MarkdownContent';
import { EmptyState } from '@/components/EmptyState';
import { DeleteDraftButton } from '@/components/research/DeleteDraftButton';
import { ResearchStatusActionButton } from '@/components/research/ResearchStatusActionButton';
import { MetaItem, MetaRow } from '@/components/domain/MetaRow';
import { SectionCard } from '@/components/domain/SectionCard';
import { StatusBadge } from '@/components/domain/StatusBadge';
import { TagChip, TagList } from '@/components/domain/TagChip';
import { LoadingState } from '@/components/StateMessage';
import { useCurrentUser } from '@/lib/auth/client';
import { BackToSearchButton } from '@/components/domain/BackToSearchButton';
import { AppButton } from '@/components/material/AppButton';
import { space } from '@deep-research/design-system';
import {
  cleanResearchLabel,
  cleanResearchMarkdown,
  cleanResearchText,
} from '@/lib/research-markdown-cleanup';
import { resolveResearchSourceLink } from '@/lib/research-source-link';
import styles from '../research-detail.module.css';
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
  X,
} from 'lucide-react';

interface ResearchSourceItem {
  id: string;
  sourceRef: { type?: string; value?: string; anchor?: SavedSourceAnchor | null } | unknown;
  canonicalKey: string;
  title: string | null;
  description: string | null;
}

interface SavedSourceAnchor {
  quote?: string;
  prefix?: string;
  suffix?: string;
  startOffset?: number;
  endOffset?: number;
  contentHash?: string;
  selectorPath?: string;
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
  researchTopics?: Array<{ topic: { id: string; slug: string; name: string } }>;
  reviewDisclosure?: Array<{
    claimId: string;
    claim: string;
    action: 'accept_uncertainty';
    label: string;
    reason: string | null;
    evidenceStatus: 'supported' | 'unverified' | 'contradicted';
  }>;
  sourceComment: SourceCommentItem | null;
  audits?: AuditEntry[];
  commentCount?: number;
}

interface AuditEntry {
  id: string;
  action: string;
  diff: unknown;
  sourceIntent?: string | null;
  sourceQuestion?: string | null;
  reason?: string | null;
  createdAt: string;
  editor: { id: string; name: string };
}

/** Add a bounded fragment understood by the reader extension. The fragment
 * is harmless when the extension is not installed and preserves the saved
 * quote as the source of truth in the research library. */
function addReaderAnchor(href: string, anchor: SavedSourceAnchor): string {
  try {
    const url = new URL(href, window.location.origin);
    if (!/^https?:$/u.test(url.protocol) || !anchor.quote) return href;
    const payload = JSON.stringify({
      quote: anchor.quote.slice(0, 12_000),
      prefix: anchor.prefix?.slice(0, 500),
      suffix: anchor.suffix?.slice(0, 500),
      startOffset: anchor.startOffset,
      endOffset: anchor.endOffset,
      contentHash: anchor.contentHash,
      selectorPath: anchor.selectorPath,
    });
    // Keep a documentation section hash intact. The extension also accepts
    // the legacy hash form, but new links carry the bounded payload in a
    // query parameter so the site's own fragment navigation still works.
    url.searchParams.set('deep-research-anchor', payload);
    return url.toString();
  } catch {
    return href;
  }
}

export default function ResearchDetailPage() {
  const params = useParams<{ id: string }>();
  const router = useRouter();
  const queryClient = useQueryClient();
  const me = useCurrentUser();
  const [discussionOpen, setDiscussionOpen] = useState(false);
  const [loadingElapsed, setLoadingElapsed] = useState(0);

  const { data, isLoading, isError, error, refetch } = useQuery<ResearchDetail>({
    queryKey: ['research', params.id],
    queryFn: async () => {
      const controller = new AbortController();
      const timeout = window.setTimeout(() => controller.abort(), 15_000);
      try {
        const res = await fetch(`/api/researches/${params.id}`, { signal: controller.signal });
        if (!res.ok) {
          if (res.status === 404) throw new Error('调研库不存在');
          throw new Error('加载失败');
        }
        return res.json();
      } catch (cause) {
        if (cause instanceof DOMException && cause.name === 'AbortError') {
          throw new Error('加载调研超时，请重试。');
        }
        throw cause;
      } finally {
        window.clearTimeout(timeout);
      }
    },
    retry: 1,
  });

  useEffect(() => {
    if (!isLoading) {
      setLoadingElapsed(0);
      return;
    }
    const startedAt = Date.now();
    const timer = window.setInterval(() => {
      setLoadingElapsed(Math.floor((Date.now() - startedAt) / 1000));
    }, 1000);
    return () => window.clearInterval(timer);
  }, [isLoading]);

  if (isLoading) {
    return (
      <div className={styles.readingScreen} aria-busy="true">
        <div className={styles.loadingHeading}>
          <Skeleton variant="text" height={16} width={128} />
          <Skeleton variant="text" height={32} width="100%" sx={{ maxWidth: 672 }} />
          <Skeleton variant="text" height={16} width={192} />
        </div>
        <LoadingState
          label={
            loadingElapsed >= 5
              ? '正文仍在加载，正在准备阅读视图…'
              : '正在加载调研正文…'
          }
        />
        {loadingElapsed >= 10 ? (
          <div className={styles.loadingRetry}>
            <span>响应时间较长，可以重新尝试。</span>
            <AppButton type="button" size="small" variant="outlined" onClick={() => void refetch()}>
              重新加载
            </AppButton>
          </div>
        ) : null}
        <Skeleton variant="rounded" height={192} width="100%" />
      </div>
    );
  }

  if (isError || !data) {
    return (
      <div className={styles.readingScreen}>
        <EmptyState
          title={error instanceof Error ? error.message : '调研库不存在'}
          action={
            <AppButton component={Link} href="/researches" variant="outlined" size="small">
              返回列表
            </AppButton>
          }
        />
      </div>
    );
  }

  const isLongResearch = data.type === 'research';
  const isKnowledge = data.type === 'knowledge';
  const isDraft = data.status === 'draft';
  const isArchived = data.status === 'archived';

  const displayTitle = cleanResearchLabel(data.title);

  return (
    <div className={`material-surface ${styles.screen}`}>
      {/* 头部 */}
      <div className={styles.header}>
        <div className={styles.headerMain}>
          <nav className={styles.breadcrumbs}>
            <BackToSearchButton />
            <Link href="/researches" className={styles.breadcrumbLink}>
              研究库
            </Link>
            <span>/</span>
            <span className={styles.breadcrumbsCurrent}>{displayTitle}</span>
          </nav>

          <Typography component="h1" variant="pageTitle" className={styles.pageTitle}>
            {displayTitle}
          </Typography>

          <div className={styles.badges}>
            <StatusBadge kind="researchType" value={isLongResearch ? 'research' : 'knowledge'} />
            <StatusBadge kind="method" value={data.creationMethod} />
            {isDraft && <StatusBadge kind="research" value="draft" />}
            {data.featuredAt && <StatusBadge kind="featured" value="true" icon={<Star />} />}
          </div>

          <MetaRow className={styles.metaRow}>
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
          <div className={styles.actions}>
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
              <AppButton
                component={Link}
                href={`/researches/${data.id}/edit`}
                variant="outlined"
                size="small"
                startIcon={<Pencil size={16} aria-hidden="true" />}
              >
                编辑
              </AppButton>
            )}
          </div>
        ) : null}
      </div>

      {data.tags.length > 0 && (
        <TagList className={styles.tags}>
          {data.tags.map((t) => (
            <TagChip key={t}>{t}</TagChip>
          ))}
        </TagList>
      )}

      <div className={styles.columns}>
      <div className={styles.mainColumn}>
        {/* ── 长文布局：研究摘要 → 正文；参考文献由正文引用承担 ── */}
        {isLongResearch && (
          <>
            {(data.background || data.conclusion || data.risks) && (
              <SectionCard
                title="研究摘要"
                tone="default"
                icon={Info}
                variant="reading"
                bodySpacing="top"
              >
                <div className={styles.summarySections}>
                  {data.background && (
                    <SectionCard tone="info" icon={Info} title="背景">
                      <MarkdownContent content={cleanResearchMarkdown(data.background)} />
                    </SectionCard>
                  )}
                  {data.conclusion && (
                    <SectionCard tone="success" icon={CheckCircle2} title="结论">
                      <MarkdownContent content={cleanResearchMarkdown(data.conclusion)} />
                    </SectionCard>
                  )}
                  {data.risks && (
                    <SectionCard tone="destructive" icon={AlertTriangle} title="风险与待验证项">
                      <MarkdownContent content={cleanResearchMarkdown(data.risks)} />
                    </SectionCard>
                  )}
                </div>
              </SectionCard>
            )}

            <SectionCard title="正文">
              <MarkdownContent content={cleanResearchMarkdown(data.body)} />
            </SectionCard>

            {data.reviewDisclosure && data.reviewDisclosure.length > 0 && (
              <SectionCard title="不确定性说明" tone="warning" icon={AlertTriangle}>
                <p className={styles.disclosureIntro}>
                  这份调研保留了以下尚未完全确定的结论，阅读时请结合原文证据和风险说明判断。
                </p>
                <ul className={styles.disclosureList}>
                  {data.reviewDisclosure.map((item) => (
                    <li key={item.claimId} className={styles.disclosureItem}>
                      <p className={styles.disclosureClaim}>{item.claim}</p>
                      <p className={styles.disclosureNote}>
                        {item.label}{item.reason ? ` · ${item.reason}` : ''}
                      </p>
                    </li>
                  ))}
                </ul>
              </SectionCard>
            )}

          </>
        )}

        {/* ── 精华布局：sourceComment 引用 + 短 body + 来源评论跳转 ── */}
        {isKnowledge && (
          <>
            {data.sourceComment && (
              <SectionCard title="来源评论" tone="accent">
                <blockquote className={styles.quote}>
                  {cleanResearchText(data.sourceComment.body)}
                </blockquote>
                <div className={styles.sourceMeta}>
                  <span>来自 {data.sourceComment.authorName}</span>
                  {data.sourceComment.targetId && (
                    <Link
                      href={
                        data.sourceComment.targetType === 'summary'
                          ? `/radar/${data.sourceComment.targetId}`
                          : `/researches/${data.sourceComment.targetId}`
                      }
                      className={styles.sourceTargetLink}
                    >
                      <ArrowUpRight size={12} />
                      查看原始{data.sourceComment.targetType === 'summary' ? '摘要' : '研究报告'}:{' '}
                      {cleanResearchLabel(data.sourceComment.targetTitle ?? '...')}
                    </Link>
                  )}
                </div>
              </SectionCard>
            )}

            {data.researchTopics?.length ? (
              <Box component="nav" aria-label="关联专题" sx={{ display: 'flex', flexWrap: 'wrap', gap: 1 }}>
                {data.researchTopics.map(({ topic }) => <Link key={topic.id} href={`/topics/${topic.slug}`}>{topic.name}</Link>)}
              </Box>
            ) : null}
            {data.researchSources.length > 0 && (
              <SectionCard title="来源" tone="muted">
                <div className={styles.sourceItems}>
                  {data.researchSources.map((source) => {
                    const ref = source.sourceRef && typeof source.sourceRef === 'object'
                      ? source.sourceRef as { type?: string; value?: string; anchor?: SavedSourceAnchor | null; radarSummaryId?: string }
                      : {};
                    const link = resolveResearchSourceLink(ref, source.canonicalKey);
                    if (!link) return null;
                    const anchor = ref.anchor && typeof ref.anchor === 'object' ? ref.anchor : null;
                    const readerHref = anchor?.quote ? addReaderAnchor(link.href, anchor) : link.href;
                    return (
                      <div key={source.id} className={styles.sourceItem}>
                        <a
                          href={readerHref}
                          target={link.external ? '_blank' : undefined}
                          rel={link.external ? 'noreferrer' : undefined}
                          className={styles.sourceLink}
                        >
                          <ArrowUpRight size={14} className={styles.sourceLinkIcon} />
                          <span className={styles.sourceLinkText}>{cleanResearchLabel(source.title ?? source.canonicalKey)}</span>
                        </a>
                        {ref.radarSummaryId && /^[0-9a-f-]{36}$/iu.test(ref.radarSummaryId) ? (
                          <Link href={`/radar/${ref.radarSummaryId}`} className={styles.sourceLink}>关联雷达</Link>
                        ) : null}
                        {source.description ? (
                          <p className={styles.sourceDescription}>{cleanResearchText(source.description)}</p>
                        ) : null}
                        {anchor?.quote ? (
                          <div className={styles.anchor}>
                            <p className={styles.anchorTitle}>已保存原文锚点</p>
                            <p className={styles.anchorQuote}>“{cleanResearchText(anchor.quote)}”</p>
                            <p className={styles.anchorHelp}>打开原文后点击阅读插件会尝试定位；如果正文已变化，插件会明确提示无法准确定位。</p>
                          </div>
                        ) : null}
                      </div>
                    );
                  })}
                </div>
              </SectionCard>
            )}

            <SectionCard title="正文">
              <MarkdownContent content={cleanResearchMarkdown(data.body)} />
            </SectionCard>

            {data.background && (
              <SectionCard title="背景">
                <MarkdownContent content={cleanResearchMarkdown(data.background)} />
              </SectionCard>
            )}

            {data.conclusion && (
              <SectionCard title="结论" tone="success" icon={CheckCircle2}>
                <MarkdownContent content={cleanResearchMarkdown(data.conclusion)} />
              </SectionCard>
            )}

            {/* 风险字段:knowledge 布局也读 risks,字段对齐 research 布局 */}
            {data.risks && (
              <SectionCard title="风险与待验证项" tone="destructive" icon={AlertTriangle}>
                <MarkdownContent content={cleanResearchMarkdown(data.risks)} />
              </SectionCard>
            )}
          </>
        )}
      </div>

      <aside className={styles.aside}>
        <SectionCard title="证据卡" tone="muted" icon={Info}>
          {/* D5/D6:证据卡「内容类型」「更新时间」对齐 SectionCard tone="muted" 风格;
              顶部 MetaRow 已展示「作者/创建/发布/评论数」,证据卡不重复 */}
          <dl className={styles.evidenceList}>
            <div className={styles.evidenceItem}><dt>状态</dt><dd>{isDraft ? '草稿' : data.status === 'published' ? '已发布' : '已归档'}</dd></div>
            <div className={styles.evidenceItem}><dt>内容类型</dt><dd>{isLongResearch ? '研究报告' : '知识卡片'}</dd></div>
            <div className={styles.evidenceItem}><dt>更新时间</dt><dd className={styles.evidenceDate}>{new Date(data.updatedAt).toISOString().slice(0, 10)}</dd></div>
          </dl>
        </SectionCard>
        {data.status === 'published' ? (
          <SectionCard
            title="团队讨论"
            tone="muted"
            icon={MessageSquare}
            actions={
              <AppButton type="button" variant="outlined" size="small" onClick={() => setDiscussionOpen(true)}>
                <MessageSquare size={16} aria-hidden="true" />
                打开讨论
              </AppButton>
            }
          >
            <p className={styles.discussionHint}>发布后可在这里查看评论、回复并继续协作。</p>
          </SectionCard>
        ) : null}
      </aside>
      </div>

      {/* 审计历史 */}
      {data.audits && data.audits.length > 0 && (
        <details className={styles.audit}>
          <summary className={styles.auditSummary}>
            修改历史 ({data.audits.length})
          </summary>
          <div className={styles.auditEntries}>
            {data.audits.map((a) => (
              <div key={a.id} className={styles.auditEntry}>
                <span className={styles.auditAction}>
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
                {a.sourceIntent === 'revise' ? (
                  <div className={styles.auditRevision}>
                    <span className={styles.auditRevisionLabel}>来自追问修订</span>
                    {a.sourceQuestion ? <span className={styles.auditQuestion}>：{a.sourceQuestion}</span> : null}
                  </div>
                ) : null}
              </div>
            ))}
          </div>
        </details>
      )}

      {data.status === 'published' ? (
        <Drawer open={discussionOpen} anchor="right" onClose={() => setDiscussionOpen(false)} slotProps={{
          paper: {
            className: 'material-surface',
            role: 'dialog',
            'aria-modal': true,
            'aria-labelledby': 'research-discussion-title',
            'aria-describedby': 'research-discussion-description',
            sx: {
              display: 'flex', flexDirection: 'column', width: { xs: '100%', sm: '448px' }, maxWidth: '100vw',
              borderRadius: 0,
            },
          },
        }}>
          <Box component="header" sx={{ display: 'flex', minHeight: '56px', alignItems: 'center', gap: space.sm, borderBottom: 1, borderColor: 'divider', paddingInline: space.lg }}>
            <MessageSquare size={18} aria-hidden="true" color="var(--dr-color-text-secondary)" />
            <Typography id="research-discussion-title" component="h2" variant="control" sx={{ flex: 1, fontWeight: 600 }}>
              讨论 · {data.commentCount ?? 0} 条
            </Typography>
            <IconButton aria-label="关闭讨论" onClick={() => setDiscussionOpen(false)}><X size={20} aria-hidden="true" /></IconButton>
          </Box>
          <Typography id="research-discussion-description" sx={{ position: 'absolute', width: 1, height: 1, overflow: 'hidden', clipPath: 'inset(50%)' }}>
            针对这篇调研的团队讨论与回复
          </Typography>
          <Box sx={{ minHeight: 0, flex: 1, overflowY: 'auto', padding: space.lg }}>
            <CommentSection targetType="research" targetId={data.id} currentUserId={me.data?.id ?? null} currentUserRole={me.data?.role ?? null} content={data.body} />
          </Box>
        </Drawer>
      ) : null}
    </div>
  );
}
