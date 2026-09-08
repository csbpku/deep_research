'use client';

// 专题详情 V2：4 个标签切换（ADR 0010）。
//
// 标签：概览 / 热点议题 / 相关研究 / 来源。
// 客户端组件：1) 切换视图并同步 URL；2) 在议题视图中显式标记已读；
// 3) 只在概览视图展示趋势和时间线，避免每个标签重复占用阅读空间。

import { useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import {
  ArrowLeft,
  CalendarRange,
  CheckCheck,
  ChevronRight,
  FileText,
  Loader2,
  ListTree,
  RefreshCw,
  Sparkles,
} from 'lucide-react';

import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { PageHeader } from '@/components/domain/PageHeader';
import { StatusBadge } from '@/components/domain/StatusBadge';
import { TopicFollowButton } from '@/components/topics/TopicFollowButton';
import { formatSourceType } from '@/lib/radar/source-labels';
import type { TopicCandidateTrendPoint } from '@/lib/topics';
import type { ReactNode } from 'react';

interface TopicPayload {
  id: string;
  slug: string;
  name: string;
  summary: string | null;
  tier: string;
  candidateCount: number;
  sourceCount: number;
  aggregationWindowStart: string;
  aggregationWindowEnd: string;
  lastSyncedAt: string | null;
  synthesisPayload: SynthesisPayloadV2 | null;
  synthesisErrorCode: string | null;
  synthesisErrorMessage: string | null;
  lastSynthesisSuccessAt: string | null;
  candidateTrend: TopicCandidateTrendPoint[];
}

export interface SynthesisPayloadV2 {
  tldr?: string;
  keyChanges?: Array<{ title: string; whyItMatters: string; summaryIds: string[] }>;
  subtopics?: Array<{ title: string; summary: string }>;
  openQuestions?: string[];
  sections?: Array<{ title: string; content: string; summaryIds?: string[] }>;
  references?: Array<{ summaryId: string; title: string; url?: string; canonicalUrl?: string }>;
}

interface IssueRow {
  id: string;
  title: string;
  proposition: string;
  kind: 'event' | 'problem';
  importanceScore: number;
  firstSeenAt: string;
  lastSeenAt: string;
  candidateIds: string[];
}

interface ResearchRow {
  researchId: string;
  researchTitle: string;
  researchStatus: string;
  researchType: string;
  createdAt: string;
}

interface CandidateRow {
  summaryId: string;
  title: string;
  url: string;
  originalKind: string;
  tags: string[];
  interpretation: string | null;
  publishedAt: string | null;
  issueId?: string;
}

interface ViewedResponse {
  ok: boolean;
  lastViewedAt: string | null;
}

/** “暂无活跃议题”文案统一：overview 末尾 + issues tab 共用，避免两处不一致。 */
const NO_ACTIVE_ISSUE_COPY = (candidateCount: number) =>
  candidateCount > 0
    ? `累计 ${candidateCount} 条相关内容但尚未触发议题；保持关注，新内容累计后会生成。`
    : '暂无活跃热点议题；AI 会在窗口内相关内容累计足够时自动生成。';

interface Props {
  topic: TopicPayload;
  issues: IssueRow[];
  issueTotalCount: number;
  issueUnreadCount: number;
  researchTopics: ResearchRow[];
  candidates: CandidateRow[];
  sourceIssues: Array<{ id: string; title: string }>;
  followed: boolean;
  isAuthenticated: boolean;
  isAdmin: boolean;
}

// Tier 徽章已收敛进 StatusBadge kind="topicTier",颜色不再散落于此。

const TAB_KEYS = ['overview', 'issues', 'research', 'sources'] as const;
type TabKey = (typeof TAB_KEYS)[number];

function parseTab(value: string | null): TabKey {
  return TAB_KEYS.includes(value as TabKey) ? (value as TabKey) : 'overview';
}

export function TopicDetailTabs({
  topic,
  issues,
  issueTotalCount,
  issueUnreadCount,
  researchTopics,
  candidates,
  sourceIssues,
  followed,
  isAuthenticated,
  isAdmin,
}: Props) {
  const pathname = usePathname();
  const router = useRouter();
  const searchParams = useSearchParams();
  const rootRef = useRef<HTMLDivElement>(null);
  const urlTab = parseTab(searchParams.get('tab'));
  const [tab, setTab] = useState<TabKey>(urlTab);
  const [isFollowed, setIsFollowed] = useState(followed);
  const [clientUnreadCount, setClientUnreadCount] = useState(issueUnreadCount);
  const [viewedAt, setViewedAt] = useState<string | null>(null);
  const [markingViewed, setMarkingViewed] = useState(false);
  const [viewError, setViewError] = useState<string | null>(null);

  // 标签是独立的阅读任务：切换后从目标视图顶部开始，避免落在旧视图的
  // 深层滚动位置；URL 状态也让刷新、复制链接和浏览器前进后退保持一致。
  useEffect(() => {
    setTab(urlTab);
  }, [urlTab]);

  useEffect(() => {
    setIsFollowed(followed);
    setClientUnreadCount(issueUnreadCount);
  }, [followed, issueUnreadCount]);

  useEffect(() => {
    const main = rootRef.current?.closest('main');
    main?.scrollTo({ top: 0, left: 0, behavior: 'auto' });
  }, [tab]);

  async function markIssuesViewed() {
    if (!isFollowed || markingViewed) return;
    setMarkingViewed(true);
    setViewError(null);
    try {
      const response = await fetch(`/api/topics/${encodeURIComponent(topic.slug)}/viewed`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{}',
      });
      if (!response.ok) throw new Error('view update failed');
      const value = (await response.json()) as ViewedResponse;
      if (!value.lastViewedAt) throw new Error('view timestamp missing');
      setViewedAt(value.lastViewedAt);
      router.refresh();
    } catch {
      setViewError('标记已读失败，请稍后重试。');
    } finally {
      setMarkingViewed(false);
    }
  }

  function handleTabChange(value: string) {
    const next = parseTab(value);
    setTab(next);
    const nextParams = new URLSearchParams(searchParams.toString());
    if (next === 'overview') {
      nextParams.delete('tab');
    } else {
      nextParams.set('tab', next);
    }
    const query = nextParams.toString();
    router.replace(query ? `${pathname}?${query}` : pathname, { scroll: false });
  }

  function handleFollowChange(next: boolean) {
    setIsFollowed(next);
    setClientUnreadCount(next ? issueTotalCount : 0);
    setViewedAt(null);
    setViewError(null);
    router.refresh();
  }

  return (
    <div ref={rootRef} className="mx-auto w-full min-w-0 max-w-shell">
      <Link href="/topics" className="mb-2 inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground">
        <ArrowLeft className="size-3" />
        返回专题列表
      </Link>
      <PageHeader
        title={topic.name}
        description={
          <>
            {topic.summary ? <span className="block">{topic.summary}</span> : null}
            <span className="mt-1 block text-xs text-muted-foreground">
              相关内容 {topic.candidateCount} · 采集渠道 {topic.sourceCount} · 上次同步{' '}
              {topic.lastSyncedAt
                ? new Date(topic.lastSyncedAt).toLocaleDateString('zh-CN')
                : '待同步'}
            </span>
          </>
        }
        actions={
          <div className="flex items-center gap-2">
            <StatusBadge kind="topicTier" value={topic.tier} />
            <Button asChild size="sm" className="min-h-11 sm:min-h-9">
              <Link
                href={
                  isAuthenticated
                    ? `/ai-research?topic=${encodeURIComponent(topic.name)}&topicId=${encodeURIComponent(topic.id)}`
                    : `/signin?callbackUrl=${encodeURIComponent(`/ai-research?topic=${topic.name}&topicId=${topic.id}`)}`
                }
              >
                <Sparkles className="size-3.5" />
                {isAuthenticated ? '开始 AI 调研' : '登录后开始 AI 调研'}
              </Link>
            </Button>
            <TopicFollowButton
              slug={topic.slug}
              initialFollowed={isFollowed}
              isAuthenticated={isAuthenticated}
              onFollowChange={handleFollowChange}
            />
          </div>
        }
      />

      {/* 顶部 sticky tabs：移动端只让此容器横向滚动，不让整页被撑宽。 */}
      <Tabs
        value={tab}
        onValueChange={handleTabChange}
        className="mt-2 min-w-0"
      >
        <div className="sticky top-[-1.5rem] z-10 -mx-4 w-[calc(100%+2rem)] min-w-0 max-w-none border-b border-border bg-background/95 px-4 backdrop-blur supports-[backdrop-filter]:bg-background/80">
          <TabsList className="grid w-full min-w-0 grid-cols-2 gap-0 border-b-0 sm:inline-flex sm:w-auto sm:min-w-max">
            <TabsTrigger value="overview" className="min-h-11 whitespace-nowrap sm:min-h-0">
              <Sparkles className="size-3.5" /> 概览
            </TabsTrigger>
            <TabsTrigger value="issues" className="min-h-11 whitespace-nowrap sm:min-h-0">
              {/* icon 颜色跟随 trigger 状态(active 由 tabs.tsx 的 data-[state=active] 控制),
                  不再 inline 强制 text-primary —— 修复 v7 review 提到的颜色打架 */}
              <Sparkles className="size-3.5" /> 热点议题（{issueTotalCount}）
            </TabsTrigger>
            <TabsTrigger value="research" className="min-h-11 whitespace-nowrap sm:min-h-0">
              <FileText className="size-3.5" /> 相关研究（{researchTopics.length}）
            </TabsTrigger>
            <TabsTrigger value="sources" className="min-h-11 whitespace-nowrap sm:min-h-0">
              <ListTree className="size-3.5" /> 相关内容（{topic.candidateCount}）
            </TabsTrigger>
          </TabsList>
        </div>

        <TabsContent value="overview" className="mt-4">
          <OverviewPane
            topic={topic}
            issues={issues}
            issueTotalCount={issueTotalCount}
            candidates={candidates}
            isAdmin={isAdmin}
          />
        </TabsContent>
        <TabsContent value="issues" className="mt-4">
          <IssuesPane
            slug={topic.slug}
            issues={issues}
            issueTotalCount={issueTotalCount}
            issueUnreadCount={clientUnreadCount}
            candidateCount={topic.candidateCount}
            viewedAt={viewedAt}
            followed={isFollowed}
            markingViewed={markingViewed}
            viewError={viewError}
            onMarkViewed={() => void markIssuesViewed()}
          />
        </TabsContent>
        <TabsContent value="research" className="mt-4">
          <ResearchPane
            topicName={topic.name}
            topicId={topic.id}
            researchTopics={researchTopics}
            isAuthenticated={isAuthenticated}
          />
        </TabsContent>
        <TabsContent value="sources" className="mt-4">
          <SourcesPane
            candidates={candidates}
            candidateTotalCount={topic.candidateCount}
            sourceCount={topic.sourceCount}
            sourceIssues={sourceIssues}
          />
        </TabsContent>

      </Tabs>
    </div>
  );
}

function OverviewPane({
  topic,
  issues,
  issueTotalCount,
  candidates,
  isAdmin,
}: {
  topic: TopicPayload;
  issues: IssueRow[];
  issueTotalCount: number;
  candidates: CandidateRow[];
  isAdmin: boolean;
}): ReactNode {
  const synthesis = topic.synthesisPayload;
  const referenceCount = new Set(
    (synthesis?.references ?? []).map((reference) => reference.summaryId),
  ).size;
  const keyChanges = synthesis?.keyChanges ?? [];
  const hasKeyChanges = keyChanges.length > 0;
  if (topic.synthesisErrorCode && !synthesis) {
    return (
      <Card>
        <CardContent className="space-y-2 p-4">
          {isAdmin ? (
            <p className="text-sm text-destructive">
              综述生成失败（{topic.synthesisErrorCode}）：{topic.synthesisErrorMessage}
            </p>
          ) : (
            <p className="text-sm text-muted-foreground">AI 综述暂时不可用,请稍后再试。</p>
          )}
          {topic.lastSynthesisSuccessAt ? (
            <p className="text-xs text-muted-foreground">
              上次成功更新：{new Date(topic.lastSynthesisSuccessAt).toLocaleString('zh-CN')}
            </p>
          ) : null}
          {isAdmin ? (
            <form
              action={`/api/topics/${topic.slug}/synthesis/retry`}
              method="post"
              onSubmit={(e) => {
                if (!window.confirm('重新生成 AI 综述会消耗模型调用额度,确认继续?')) {
                  e.preventDefault();
                }
              }}
            >
              <Button type="submit" size="sm" variant="outline">
                重试综述
              </Button>
            </form>
          ) : null}
        </CardContent>
      </Card>
    );
  }
  if (!synthesis || !synthesis.tldr) {
    return (
      <div className="space-y-5">
        <section className="rounded-md border border-primary/20 bg-primary/[0.035] p-4">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div className="min-w-0">
              <h2 className="flex items-center gap-1.5 text-sm font-semibold">
                <Sparkles className="size-4 text-primary" /> AI 综述暂未就绪
              </h2>
              <SynthesisPendingNotice
                hasError={Boolean(topic.synthesisErrorMessage)}
                lastSuccessAt={topic.lastSynthesisSuccessAt}
              />
            </div>
            {isAdmin ? (
              <form
                action={`/api/topics/${topic.slug}/synthesis/retry`}
                method="post"
                onSubmit={(e) => {
                  if (!window.confirm('重新生成 AI 综述会消耗模型调用额度，确认继续？')) {
                    e.preventDefault();
                  }
                }}
              >
                <Button type="submit" size="sm" variant="outline">
                  重试综述
                </Button>
              </form>
            ) : null}
          </div>
          <div className="mt-4 grid gap-2 sm:grid-cols-3">
            <div className="rounded-md border border-border/70 bg-card/70 p-3">
              <p className="text-[11px] text-muted-foreground">相关内容</p>
              <p className="mt-1 font-mono text-lg font-semibold tabular-nums">{topic.candidateCount}</p>
            </div>
            <div className="rounded-md border border-border/70 bg-card/70 p-3">
              <p className="text-[11px] text-muted-foreground">活跃议题</p>
              <p className="mt-1 font-mono text-lg font-semibold tabular-nums">{issueTotalCount}</p>
            </div>
            <div className="rounded-md border border-border/70 bg-card/70 p-3">
              <p className="text-[11px] text-muted-foreground">采集渠道</p>
              <p className="mt-1 font-mono text-lg font-semibold tabular-nums">{topic.sourceCount}</p>
            </div>
          </div>
        </section>

        <RecentIssuesPreview topic={topic} issues={issues} issueTotalCount={issueTotalCount} />
        <div className="grid items-start gap-4 md:grid-cols-2">
          <TrendPane topic={topic} />
          <Card>
            <CardContent className="p-4">
              <h2 className="mb-2 flex items-center gap-1.5 text-sm font-semibold">
                <ListTree className="size-4 text-muted-foreground" />
                时间线
              </h2>
              <TimelinePane candidates={candidates} />
            </CardContent>
          </Card>
        </div>
      </div>
    );
  }
  /* 综述改成长文块 + 嵌入式 section divider,只在「事实审核」保留 Card */
  return (
    <div className="space-y-5 text-sm">
      <section>
        <h2 className="flex items-center gap-1.5 text-sm font-semibold">
          <Sparkles className="size-4 text-muted-foreground" aria-hidden /> 一句话概要
        </h2>
        <p className="mt-2 max-w-4xl text-base font-medium leading-relaxed">{synthesis.tldr}</p>
        {topic.lastSynthesisSuccessAt ? (
          <p className="mt-1.5 text-xs text-muted-foreground">
            最近更新：{new Date(topic.lastSynthesisSuccessAt).toLocaleString('zh-CN')}
          </p>
        ) : null}
        {referenceCount > 0 ? (
          <Link
            href="#topic-evidence"
            className="mt-2 inline-flex items-center gap-1 text-xs font-medium text-primary hover:underline"
          >
            <FileText className="size-3.5" />
            查看综述依据（{referenceCount}）
          </Link>
        ) : null}
      </section>

      <RecentIssuesPreview
        topic={topic}
        issues={issues}
        issueTotalCount={issueTotalCount}
      />

      <div className="grid items-start gap-4 md:grid-cols-2">
        <TrendPane topic={topic} />
        <Card>
          <CardContent className="p-4">
            <h2 className="mb-2 flex items-center gap-1.5 text-sm font-semibold">
              <ListTree className="size-4 text-muted-foreground" />
              时间线
            </h2>
            <TimelinePane candidates={candidates} />
          </CardContent>
        </Card>
      </div>

      {hasKeyChanges ? (
        <section id="topic-evidence" className="scroll-mt-28">
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <h2 className="text-sm font-semibold">为什么重要</h2>
            {referenceCount > 0 ? (
              <span className="text-xs text-muted-foreground">
                {referenceCount} 条可回溯来源
              </span>
            ) : null}
          </div>
          <ul className="mt-2 grid list-none gap-2 p-0">
            {keyChanges.map((kc, i) => (
              <li key={i} className="rounded-md border border-border bg-card/60 p-3">
                <p className="font-medium">{kc.title}</p>
                <p className="mt-1 text-xs text-muted-foreground">{kc.whyItMatters}</p>
                <EvidenceDisclosure
                  summaryIds={kc.summaryIds}
                  candidates={candidates}
                  references={synthesis.references ?? []}
                />
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {referenceCount > 0 && !hasKeyChanges ? (
        <EvidenceListSection references={synthesis.references ?? []} />
      ) : null}

      {synthesis.subtopics && synthesis.subtopics.length > 0 ? (
        <details className="group">
          <summary className="cursor-pointer list-none text-sm font-semibold [&::-webkit-details-marker]:hidden">
            <span className="inline-flex items-center gap-1.5">
              <ChevronRight className="size-4 text-muted-foreground transition-transform group-open:rotate-90" />
              子方向
            </span>
          </summary>
          <ul className="mt-2 grid list-none gap-2 border-l-2 border-border pl-3">
            {synthesis.subtopics.map((st, i) => (
              <li key={i} className="border-b border-border pb-2 last:border-0">
                <p className="font-medium">{st.title}</p>
                <p className="mt-1 text-xs text-muted-foreground">{st.summary}</p>
              </li>
            ))}
          </ul>
        </details>
      ) : null}

      {synthesis.openQuestions && synthesis.openQuestions.length > 0 ? (
        <details className="group">
          <summary className="cursor-pointer list-none text-sm font-semibold [&::-webkit-details-marker]:hidden">
            <span className="inline-flex items-center gap-1.5">
              <ChevronRight className="size-4 text-muted-foreground transition-transform group-open:rotate-90" />
              仍然开放的问题
            </span>
          </summary>
          <ul className="mt-2 list-disc space-y-1 border-l-2 border-border pl-7 text-xs text-muted-foreground">
            {synthesis.openQuestions.map((q, i) => (
              <li key={i}>{q}</li>
            ))}
          </ul>
        </details>
      ) : null}

      {synthesis.sections && synthesis.sections.length > 0 ? (
        <details className="group">
          <summary className="cursor-pointer list-none text-sm font-semibold [&::-webkit-details-marker]:hidden">
            <span className="inline-flex items-center gap-1.5">
              <ChevronRight className="size-4 text-muted-foreground transition-transform group-open:rotate-90" />
              深度阅读
            </span>
          </summary>
          <div className="mt-2 space-y-3 border-l-2 border-primary/30 pl-3">
            {synthesis.sections.map((s, i) => (
              <section key={i} className="border-b border-border pb-3 last:border-0">
                <h3 className="mb-1 text-sm font-semibold">{s.title}</h3>
                <p className="whitespace-pre-wrap leading-relaxed text-muted-foreground">{s.content}</p>
                <EvidenceDisclosure
                  summaryIds={s.summaryIds ?? []}
                  candidates={candidates}
                  references={synthesis.references ?? []}
                />
              </section>
            ))}
          </div>
        </details>
      ) : null}

      {issues.length === 0 ? (
        <Card>
          <CardContent className="p-4 text-xs text-muted-foreground">
            {NO_ACTIVE_ISSUE_COPY(topic.candidateCount)}
          </CardContent>
        </Card>
      ) : null}
    </div>
  );
}

function SynthesisPendingNotice({
  hasError,
  lastSuccessAt,
}: {
  hasError: boolean;
  lastSuccessAt: string | null;
}) {
  const router = useRouter();
  const [elapsed, setElapsed] = useState(0);

  useEffect(() => {
    const startedAt = Date.now();
    const timer = window.setInterval(() => {
      setElapsed(Math.floor((Date.now() - startedAt) / 1000));
    }, 1000);
    return () => window.clearInterval(timer);
  }, []);

  const slow = elapsed >= 8;
  return (
    <div className="mt-1.5 max-w-2xl space-y-1.5">
      <p className="text-xs leading-relaxed text-muted-foreground">
        {hasError
          ? '最近一次生成没有成功。你仍然可以先阅读热点议题和原始内容。'
          : slow
            ? '综述生成时间比预期长。你仍然可以先阅读热点议题和时间线，稍后刷新查看结果。'
            : '综述正在准备中。先从下方的热点议题和时间线开始，不必等待整篇综述。'}
      </p>
      {lastSuccessAt ? (
        <p className="text-[11px] text-muted-foreground">
          最近成功更新：{new Date(lastSuccessAt).toLocaleString('zh-CN')}
        </p>
      ) : null}
      {slow ? (
        <div className="flex flex-wrap items-center gap-2 pt-1 text-[11px] text-muted-foreground">
          <span>等待超过 8 秒</span>
          <Button type="button" size="xs" variant="outline" onClick={() => router.refresh()}>
            <RefreshCw />
            刷新专题
          </Button>
        </div>
      ) : null}
    </div>
  );
}

function RecentIssuesPreview({
  topic,
  issues,
  issueTotalCount,
}: {
  topic: TopicPayload;
  issues: IssueRow[];
  issueTotalCount: number;
}): ReactNode {
  if (issues.length === 0) return null;
  return (
    <section aria-labelledby="featured-topic-issues">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <div>
          <h2 id="featured-topic-issues" className="text-sm font-semibold">
            重点议题
          </h2>
          <p className="mt-0.5 text-[11px] text-muted-foreground">按重要度展示</p>
        </div>
        <Link
          href={`/topics/${encodeURIComponent(topic.slug)}?tab=issues`}
          className="text-xs font-medium text-primary hover:underline"
        >
          查看全部 {issueTotalCount} 个议题
        </Link>
      </div>
      <ul className="mt-2 grid list-none gap-2 p-0">
        {issues.slice(0, 3).map((issue) => (
          <li key={issue.id} className="border-b border-border pb-2 last:border-0">
            <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px] text-muted-foreground">
              <span>{issue.kind === 'event' ? '事件' : '问题'}</span>
              <span>最近更新 {new Date(issue.lastSeenAt).toLocaleDateString('zh-CN')}</span>
              <span>{issue.candidateIds.length} 条关联内容</span>
            </div>
            <h3 className="mt-1 line-clamp-2 text-sm font-medium">{issue.title}</h3>
            <p className="mt-0.5 max-w-4xl line-clamp-2 text-xs text-muted-foreground">{issue.proposition}</p>
          </li>
        ))}
      </ul>
    </section>
  );
}

function EvidenceDisclosure({
  summaryIds,
  candidates,
  references,
}: {
  summaryIds: string[];
  candidates: CandidateRow[];
  references: NonNullable<SynthesisPayloadV2['references']>;
}): ReactNode {
  const candidateById = new Map(candidates.map((candidate) => [candidate.summaryId, candidate] as const));
  const referenceById = new Map(references.map((reference) => [reference.summaryId, reference] as const));
  const seen = new Set<string>();
  const rows = summaryIds
    .map((summaryId) => {
      if (seen.has(summaryId)) return null;
      seen.add(summaryId);
      const candidate = candidateById.get(summaryId);
      const reference = referenceById.get(summaryId);
      return {
        summaryId,
        title: candidate?.title ?? reference?.title ?? `来源 ${summaryId.slice(0, 8)}`,
      };
    })
    .filter((row): row is { summaryId: string; title: string } => row !== null);
  if (rows.length === 0) return null;
  return (
    <details className="mt-2 text-xs">
      <summary className="cursor-pointer list-none font-medium text-primary [&::-webkit-details-marker]:hidden">
        依据 {rows.length} 条来源
      </summary>
      <ul className="mt-2 space-y-1 border-l-2 border-primary/20 pl-3">
        {rows.map((row) => (
          <li key={row.summaryId}>
            <Link href={`/radar/${row.summaryId}`} className="hover:underline">
              {row.title}
            </Link>
          </li>
        ))}
      </ul>
    </details>
  );
}

function EvidenceListSection({
  references,
}: {
  references: NonNullable<SynthesisPayloadV2['references']>;
}): ReactNode {
  const seen = new Set<string>();
  const rows = references.filter((reference) => {
    if (seen.has(reference.summaryId)) return false;
    seen.add(reference.summaryId);
    return true;
  });
  if (rows.length === 0) return null;
  return (
    <section id="topic-evidence" className="scroll-mt-28">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="text-sm font-semibold">综述依据</h2>
        <span className="text-xs text-muted-foreground">
          {rows.length} 条可回溯来源
        </span>
      </div>
      <ul className="mt-2 space-y-1 border-l-2 border-primary/20 pl-3 text-xs">
        {rows.map((reference) => (
          <li key={reference.summaryId}>
            <Link href={`/radar/${reference.summaryId}`} className="hover:underline">
              {reference.title || `来源 ${reference.summaryId.slice(0, 8)}`}
            </Link>
          </li>
        ))}
      </ul>
    </section>
  );
}

function IssuesPane({
  slug,
  issues,
  issueTotalCount,
  issueUnreadCount,
  candidateCount,
  viewedAt,
  followed,
  markingViewed,
  viewError,
  onMarkViewed,
}: {
  slug: string;
  issues: IssueRow[];
  issueTotalCount: number;
  issueUnreadCount: number;
  candidateCount: number;
  viewedAt: string | null;
  followed: boolean;
  markingViewed: boolean;
  viewError: string | null;
  onMarkViewed: () => void;
}): ReactNode {
  const [rows, setRows] = useState(issues);
  const [loadingMore, setLoadingMore] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const unreadCount = viewedAt ? 0 : issueUnreadCount;
  const hasMore = rows.length < issueTotalCount;

  async function loadMore() {
    if (loadingMore || !hasMore) return;
    setLoadingMore(true);
    setLoadError(null);
    try {
      const response = await fetch(
        `/api/topics/${encodeURIComponent(slug)}/issues?status=active&sort=importance&offset=${rows.length}`,
        { cache: 'no-store' },
      );
      if (!response.ok) throw new Error('load failed');
      const data = await response.json() as {
        total?: number;
        issues?: Array<{
          id: string;
          title: string;
          proposition: string;
          kind: 'event' | 'problem';
          importanceScore: number;
          firstSeenAt: string;
          lastSeenAt: string;
          candidates?: Array<{ summaryId: string }>;
        }>;
      };
      const nextRows = (data.issues ?? []).map((issue) => ({
        id: issue.id,
        title: issue.title,
        proposition: issue.proposition,
        kind: issue.kind,
        importanceScore: issue.importanceScore,
        firstSeenAt: issue.firstSeenAt,
        lastSeenAt: issue.lastSeenAt,
        candidateIds: (issue.candidates ?? []).map((candidate) => candidate.summaryId),
      }));
      setRows((current) => {
        const existingIds = new Set(current.map((row) => row.id));
        return [...current, ...nextRows.filter((row) => !existingIds.has(row.id))];
      });
    } catch {
      setLoadError('更多议题暂时加载失败，请稍后重试。');
    } finally {
      setLoadingMore(false);
    }
  }

  return (
    <section className="space-y-3 text-sm">
      <div className="space-y-1.5">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 className="text-sm font-semibold">活跃热点议题</h2>
          {followed && issueUnreadCount > 0 && !viewedAt ? (
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="min-h-11 sm:min-h-9"
              onClick={onMarkViewed}
              disabled={markingViewed}
            >
              {markingViewed ? <Loader2 className="animate-spin" /> : <CheckCheck />}
              {markingViewed ? '标记中…' : '标记全部已读'}
            </Button>
          ) : null}
          {viewedAt ? (
            <span className="text-[11px] text-muted-foreground">
              已标记为已读 {new Date(viewedAt).toLocaleString('zh-CN')}
            </span>
          ) : null}
        </div>
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
          <span>已显示 {rows.length} 条，共 {issueTotalCount} 条</span>
          <span>按重要度排序</span>
          {unreadCount > 0 ? <span className="text-primary">{unreadCount} 个议题在上次查看后有更新</span> : null}
        </div>
      </div>
      {viewError ? <p className="text-xs text-destructive">{viewError}</p> : null}
      {rows.length === 0 ? (
        <p className="rounded-md border border-dashed border-border bg-muted/20 p-4 text-xs text-muted-foreground">
          {NO_ACTIVE_ISSUE_COPY(candidateCount)}
        </p>
      ) : (
        <ul className="grid list-none gap-2 p-0">
          {rows.map((issue) => (
            <li key={issue.id} className="rounded-md border border-border bg-card p-3">
              <div className="flex min-w-0 flex-wrap items-start gap-1.5">
                <Badge
                  className={
                    issue.kind === 'event'
                      ? 'bg-status-running-bg text-status-running-fg'
                      : 'bg-status-failed-bg text-status-failed-fg'
                  }
                >
                  {issue.kind === 'event' ? '事件' : '问题'}
                </Badge>
                <h3 className="min-w-0 flex-1 text-sm font-medium">{issue.title}</h3>
              </div>
              <p className="mt-1 line-clamp-3 text-xs text-muted-foreground">{issue.proposition}</p>
              <div className="mt-1.5 flex flex-wrap items-center gap-2 text-[11px] text-muted-foreground">
                <span>首发 {new Date(issue.firstSeenAt).toLocaleDateString('zh-CN')}</span>
                <span>·</span>
                <span>最近更新 {new Date(issue.lastSeenAt).toLocaleDateString('zh-CN')}</span>
                {issue.candidateIds.length > 0 ? (
                  <>
                    <span>·</span>
                    <span>{issue.candidateIds.length} 条关联内容</span>
                  </>
                ) : null}
              </div>
            </li>
          ))}
        </ul>
      )}
      {loadError ? <p className="text-xs text-destructive">{loadError}</p> : null}
      {hasMore ? (
        <Button type="button" variant="outline" size="sm" className="min-h-11 sm:min-h-9" onClick={() => void loadMore()} disabled={loadingMore}>
          {loadingMore ? <Loader2 className="animate-spin" /> : null}
          {loadingMore ? '加载中…' : `加载更多议题（还剩 ${issueTotalCount - rows.length}）`}
        </Button>
      ) : null}
    </section>
  );
}

function ResearchPane({
  topicName,
  topicId,
  researchTopics,
  isAuthenticated,
}: {
  topicName: string;
  topicId: string;
  researchTopics: ResearchRow[];
  isAuthenticated: boolean;
}): ReactNode {
  const researchHref = `/ai-research?topic=${encodeURIComponent(topicName)}&topicId=${encodeURIComponent(topicId)}`;
  return (
    <section className="space-y-3 text-sm">
      <h2 className="text-sm font-semibold">相关研究（{researchTopics.length}）</h2>
      {researchTopics.length === 0 ? (
        <div className="space-y-3 rounded-md border border-dashed border-border bg-muted/20 p-4">
          <p className="text-xs text-muted-foreground">
            还没有关于本专题的已发布研究；从专题发起 AI 调研时会在发布时自动回流。
          </p>
          <Button asChild size="sm" className="min-h-11 sm:min-h-9">
            <Link
              href={
                isAuthenticated
                  ? researchHref
                  : `/signin?callbackUrl=${encodeURIComponent(researchHref)}`
              }
            >
              <Sparkles className="size-3.5" />
              {isAuthenticated ? '从本专题开始调研' : '登录后开始调研'}
            </Link>
          </Button>
        </div>
      ) : (
        <ul className="grid list-none gap-2 p-0">
          {researchTopics.map((row) => (
            <li key={row.researchId} className="rounded-md border border-border bg-card p-3">
              <div className="flex min-w-0 flex-wrap items-center gap-1.5">
                <Link
                  href={`/researches/${row.researchId}`}
                  className="min-w-0 flex-1 text-sm font-medium hover:text-primary hover:underline"
                >
                  {row.researchTitle}
                </Link>
                {row.researchStatus === 'published' ? (
                  <Badge className="bg-status-succeeded-bg text-status-succeeded-fg">已发布</Badge>
                ) : (
                  <Badge className="bg-muted text-muted-foreground">{row.researchStatus}</Badge>
                )}
                <span className="text-[11px] text-muted-foreground">
                  {new Date(row.createdAt).toLocaleDateString('zh-CN')}
                </span>
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function SourcesPane({
  candidates,
  candidateTotalCount,
  sourceCount,
  sourceIssues,
}: {
  candidates: CandidateRow[];
  candidateTotalCount: number;
  sourceCount: number;
  sourceIssues: Array<{ id: string; title: string }>;
}): ReactNode {
  // 按 issue 分组；未关联 issue 的归到「近期信号」
  const byIssue = useMemo(() => {
    const map = new Map<string, CandidateRow[]>();
    const orphan: CandidateRow[] = [];
    for (const c of candidates) {
      if (c.issueId && map.has(c.issueId)) {
        map.get(c.issueId)!.push(c);
      } else if (c.issueId) {
        map.set(c.issueId, [c]);
      } else {
        orphan.push(c);
      }
    }
    return { map, orphan };
  }, [candidates]);

  return (
    <div className="space-y-4">
      <p className="text-xs text-muted-foreground">
        共 {candidateTotalCount} 条可查看内容，来自 {sourceCount} 个采集渠道
        {candidates.length < candidateTotalCount ? `；当前已加载最近 ${candidates.length} 条` : '；已全部加载'}。
      </p>
      {sourceIssues.map((issue) => {
        const list = byIssue.map.get(issue.id) ?? [];
        if (list.length === 0) return null;
        return (
          <section key={issue.id} className="space-y-3">
            <h3 className="text-sm font-semibold">{issue.title}</h3>
            <ul className="grid list-none gap-2 p-0">
              {list.map((c) => (
                <SourceRow key={c.summaryId} candidate={c} />
              ))}
            </ul>
          </section>
        );
      })}

      <section className="space-y-3">
        <h3 className="text-sm font-semibold">
          未归入议题的{candidates.length < candidateTotalCount ? '已加载' : ''}近期信号（{byIssue.orphan.length}）
        </h3>
        {byIssue.orphan.length === 0 ? (
          <p className="rounded-md border border-dashed border-border bg-muted/20 p-4 text-xs text-muted-foreground">
            所有相关内容都已关联到热点议题；新增内容会在窗口期归类。
          </p>
        ) : (
          <ul className="grid list-none gap-2 p-0">
            {byIssue.orphan.map((c) => (
              <SourceRow key={c.summaryId} candidate={c} />
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

function SourceRow({ candidate }: { candidate: CandidateRow }): ReactNode {
  return (
    <li>
      <Link
        href={`/radar/${candidate.summaryId}`}
        className="block rounded-md border border-border p-2.5 transition-colors hover:border-primary/40"
      >
        <p className="text-sm font-medium hover:text-primary">{candidate.title}</p>
        <p className="mt-0.5 text-xs text-muted-foreground">
          {formatSourceType(candidate.originalKind).short} ·{' '}
          {candidate.publishedAt ? new Date(candidate.publishedAt).toLocaleDateString('zh-CN') : '—'}
          {candidate.tags.length > 0 ? ` · ${candidate.tags.slice(0, 3).join(', ')}` : ''}
        </p>
        {candidate.interpretation ? (
          <p className="mt-1 line-clamp-2 text-xs text-muted-foreground">{candidate.interpretation}</p>
        ) : null}
      </Link>
    </li>
  );
}

function TrendPane({ topic }: { topic: TopicPayload }): ReactNode {
  const trend = topic.candidateTrend ?? [];
  const totalInWindow = trend.reduce((sum, p) => sum + p.count, 0);
  const peak = trend.reduce<TopicCandidateTrendPoint | null>((best, p) => {
    if (!best || p.count > best.count) return p;
    return best;
  }, null);
  return (
    <Card>
      <CardContent className="space-y-3 p-4 text-sm">
        <h2 className="flex items-center gap-1.5 text-sm font-semibold">
          <CalendarRange className="size-4 text-muted-foreground" /> 趋势
        </h2>
        <p className="text-xs text-muted-foreground">
          聚合窗口：
          {new Date(topic.aggregationWindowStart).toLocaleDateString('zh-CN')} ~{' '}
          {new Date(topic.aggregationWindowEnd).toLocaleDateString('zh-CN')}
        </p>
        <TrendSparkline points={trend} />
        <p className="text-[11px] text-muted-foreground">
          过去 {trend.length} 天新增 {totalInWindow} 条相关内容
          {peak && peak.count > 0 ? `，单日峰值 ${peak.count} 条（${peak.date}）` : ''}
        </p>
      </CardContent>
    </Card>
  );
}

function TrendSparkline({ points }: { points: TopicCandidateTrendPoint[] }): ReactNode {
  if (points.length === 0) {
    return <p className="text-xs text-muted-foreground">暂无趋势数据。</p>;
  }
  const width = 280;
  const height = 48;
  const padding = 2;
  const max = Math.max(1, ...points.map((p) => p.count));
  const stepX = (width - padding * 2) / Math.max(1, points.length - 1);
  const coords = points.map((p, i) => {
    const x = padding + i * stepX;
    const y = height - padding - (p.count / max) * (height - padding * 2);
    return { x, y, ...p };
  });
  const linePath = coords
    .map((c, i) => `${i === 0 ? 'M' : 'L'} ${c.x.toFixed(2)} ${c.y.toFixed(2)}`)
    .join(' ');
  const last = coords[coords.length - 1];
  const firstDate = points[0]?.date;
  const lastDate = points[points.length - 1]?.date;
  const formatDate = (value: string | undefined) => value ? value.slice(5).replace('-', '/') : '—';
  return (
    <div className="space-y-1">
      <svg
        role="img"
        aria-label={`过去 ${points.length} 天相关内容趋势`}
        viewBox={`0 0 ${width} ${height}`}
        preserveAspectRatio="none"
        className="h-12 w-full text-primary/80"
      >
        <path d={linePath} fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round" />
        <circle
          cx={last.x}
          cy={last.y}
          r={2.5}
          fill="currentColor"
        >
          <title>{`${lastDate ?? ''} · ${last.count} 条相关内容`}</title>
        </circle>
      </svg>
      <div className="flex items-center justify-between text-[11px] text-muted-foreground">
        <span>起 {formatDate(firstDate)}</span>
        <span>止 {formatDate(lastDate)}</span>
      </div>
    </div>
  );
}

function TimelinePane({ candidates }: { candidates: CandidateRow[] }): ReactNode {
  if (candidates.length === 0) {
    return <p className="text-xs text-muted-foreground">暂无相关内容。</p>;
  }
  /* 服务端已按 addedAt desc 排序;客户端仅按 publishedAt desc 排序,
     null 的候选(尚未发布) 排到末尾,而不是最前 */
  const sorted = [...candidates].sort((a, b) => {
    const at = a.publishedAt ? new Date(a.publishedAt).getTime() : -Infinity;
    const bt = b.publishedAt ? new Date(b.publishedAt).getTime() : -Infinity;
    return bt - at;
  });
  return (
    <div className="space-y-2">
      <p className="text-[11px] text-muted-foreground">
        最近显示 {Math.min(sorted.length, 12)} 条，共 {sorted.length} 条已加载内容。
      </p>
      <ol aria-label="按发布时间排序的近期相关内容" className="grid list-none gap-1.5 p-0 text-xs">
          {sorted.slice(0, 12).map((c) => (
            <li key={c.summaryId} className="flex items-start gap-2">
              <span className="mt-1 inline-block size-1.5 shrink-0 rounded-full bg-primary" aria-hidden />
              <div className="min-w-0 flex-1">
                <p className="font-mono text-[11px] text-muted-foreground">
                  <time>{c.publishedAt ? new Date(c.publishedAt).toLocaleDateString('zh-CN') : '待发布'}</time>
                </p>
                <Link href={`/radar/${c.summaryId}`} className="line-clamp-2 hover:text-primary hover:underline">
                  {c.title}
                </Link>
              </div>
            </li>
          ))}
      </ol>
    </div>
  );
}
