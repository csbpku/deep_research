'use client';

// 专题详情 V2：4 个标签切换（ADR 0010）。
//
// 标签：概览 / 热点议题 / 相关研究 / 来源。
// 客户端组件：1) 切换视图；2) 停留后 ping /viewed；
// 3) 主趋势面板（trendPanel）始终可见，不随标签消失。

import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import {
  ArrowLeft,
  CalendarRange,
  ExternalLink,
  FileText,
  ListTree,
  Sparkles,
} from 'lucide-react';

import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { PageHeader } from '@/components/domain/PageHeader';
import { TopicFollowButton } from '@/components/topics/TopicFollowButton';
import { formatSourceType } from '@/lib/radar/source-labels';
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

interface Props {
  topic: TopicPayload;
  issues: IssueRow[];
  researchTopics: ResearchRow[];
  candidates: CandidateRow[];
  followed: boolean;
  isAdmin: boolean;
}

const TIER_LABELS: Record<string, { label: string; cls: string }> = {
  hot: { label: '热门', cls: 'bg-status-failed-bg text-status-failed-fg' },
  warming: { label: '升温', cls: 'bg-status-running-bg text-status-running-fg' },
  emerging: { label: '新出现', cls: 'bg-muted text-muted-foreground' },
};

const TAB_KEYS = ['overview', 'issues', 'research', 'sources'] as const;
type TabKey = (typeof TAB_KEYS)[number];

interface QueryState {
  tab: TabKey;
  setTab: (next: TabKey) => void;
}

export function TopicDetailTabs({ topic, issues, researchTopics, candidates, followed, isAdmin }: Props) {
  const tier = TIER_LABELS[topic.tier] ?? TIER_LABELS.emerging;
  const [tab, setTab] = useState<TabKey>('overview');
  const [viewedAt, setViewedAt] = useState<string | null>(null);

  // 停留后 ping /viewed；只在第一次到访时上报。
  useEffect(() => {
    if (!followed) return;
    const timer = window.setTimeout(() => {
      void fetch(`/api/topics/${encodeURIComponent(topic.slug)}/viewed`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{}',
      })
        .then(async (r) => {
          if (!r.ok) return null;
          return (await r.json()) as ViewedResponse;
        })
        .then((value) => {
          if (value?.lastViewedAt) setViewedAt(value.lastViewedAt);
        })
        .catch(() => undefined);
    }, 1500);
    return () => window.clearTimeout(timer);
  }, [followed, topic.slug]);

  return (
    <div className="mx-auto max-w-shell">
      <Link href="/topics" className="mb-2 inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground">
        <ArrowLeft className="size-3" />
        返回专题列表
      </Link>
      <PageHeader
        title={topic.name}
        description={topic.summary ?? undefined}
        actions={
          <div className="flex items-center gap-2">
            <Badge className={tier.cls}>{tier.label}</Badge>
            <TopicFollowButton slug={topic.slug} initialFollowed={followed} />
          </div>
        }
      />

      {/* 顶部 sticky tabs：编辑后对 4 个视图就近滚动 */}
      <Tabs
        value={tab}
        onValueChange={(value) => setTab((TAB_KEYS as readonly string[]).includes(value) ? (value as TabKey) : 'overview')}
        className="mt-2"
      >
        <div className="sticky top-12 z-10 -mx-4 border-b border-border bg-background/95 px-4 backdrop-blur supports-[backdrop-filter]:bg-background/80">
          <TabsList className="border-b-0">
            <TabsTrigger value="overview">
              <Sparkles className="size-3.5" /> 概览
            </TabsTrigger>
            <TabsTrigger value="issues">
              <Sparkles className="size-3.5 text-primary" /> 热点议题（{issues.length}）
            </TabsTrigger>
            <TabsTrigger value="research">
              <FileText className="size-3.5" /> 相关研究（{researchTopics.length}）
            </TabsTrigger>
            <TabsTrigger value="sources">
              <ListTree className="size-3.5" /> 来源（{candidates.length}）
            </TabsTrigger>
          </TabsList>
        </div>

        <TabsContent value="overview" className="mt-4">
          <OverviewPane topic={topic} issues={issues} isAdmin={isAdmin} />
        </TabsContent>
        <TabsContent value="issues" className="mt-4">
          <IssuesPane issues={issues} candidateCount={topic.candidateCount} viewedAt={viewedAt} />
        </TabsContent>
        <TabsContent value="research" className="mt-4">
          <ResearchPane researchTopics={researchTopics} />
        </TabsContent>
        <TabsContent value="sources" className="mt-4">
          <SourcesPane candidates={candidates} issues={issues} />
        </TabsContent>
      </Tabs>

      {/* 趋势面板始终可见，帮助读者快速判断窗口与同步状态 */}
      <div className="mt-4 grid gap-4 md:grid-cols-2">
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

function OverviewPane({
  topic,
  issues,
  isAdmin,
}: {
  topic: TopicPayload;
  issues: IssueRow[];
  isAdmin: boolean;
}): ReactNode {
  const synthesis = topic.synthesisPayload;
  if (topic.synthesisErrorCode && !synthesis) {
    return (
      <Card>
        <CardContent className="space-y-2 p-4">
          <p className="text-sm text-destructive">
            综述生成失败（{topic.synthesisErrorCode}）：{topic.synthesisErrorMessage}
          </p>
          {topic.lastSynthesisSuccessAt ? (
            <p className="text-xs text-muted-foreground">
              上次成功更新：{new Date(topic.lastSynthesisSuccessAt).toLocaleString('zh-CN')}
            </p>
          ) : null}
          {isAdmin ? (
            <form action={`/api/topics/${topic.slug}/synthesis/retry`} method="post">
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
      <Card>
        <CardContent className="space-y-3 p-4 text-sm">
          <h2 className="flex items-center gap-1.5 text-sm font-semibold">
            <Sparkles className="size-4 text-muted-foreground" /> AI 综述
          </h2>
          <p className="text-muted-foreground">综述生成中…</p>
          {isAdmin ? (
            <form action={`/api/topics/${topic.slug}/synthesis/retry`} method="post">
              <Button type="submit" size="sm" variant="outline">
                重试综述
              </Button>
            </form>
          ) : null}
        </CardContent>
      </Card>
    );
  }
  return (
    <div className="space-y-4">
      <Card>
        <CardContent className="space-y-3 p-4 text-sm">
          <h2 className="flex items-center gap-1.5 text-sm font-semibold">
            <Sparkles className="size-4 text-muted-foreground" /> 一句话概要
          </h2>
          <p className="text-base font-medium">{synthesis.tldr}</p>
          {topic.lastSynthesisSuccessAt ? (
            <p className="text-xs text-muted-foreground">
              最近更新：{new Date(topic.lastSynthesisSuccessAt).toLocaleString('zh-CN')}
            </p>
          ) : null}
        </CardContent>
      </Card>

      {synthesis.keyChanges && synthesis.keyChanges.length > 0 ? (
        <Card>
          <CardContent className="space-y-3 p-4 text-sm">
            <h2 className="text-sm font-semibold">为什么重要</h2>
            <ul className="grid list-none gap-3 p-0">
              {synthesis.keyChanges.map((kc, i) => (
                <li key={i} className="rounded-md border border-border bg-card/60 p-3">
                  <p className="font-medium">{kc.title}</p>
                  <p className="mt-1 text-xs text-muted-foreground">{kc.whyItMatters}</p>
                </li>
              ))}
            </ul>
          </CardContent>
        </Card>
      ) : null}

      {synthesis.subtopics && synthesis.subtopics.length > 0 ? (
        <Card>
          <CardContent className="space-y-3 p-4 text-sm">
            <h2 className="text-sm font-semibold">子方向</h2>
            <ul className="grid list-none gap-2 p-0">
              {synthesis.subtopics.map((st, i) => (
                <li key={i} className="rounded-md border border-border bg-card/60 p-3">
                  <p className="font-medium">{st.title}</p>
                  <p className="mt-1 text-xs text-muted-foreground">{st.summary}</p>
                </li>
              ))}
            </ul>
          </CardContent>
        </Card>
      ) : null}

      {synthesis.openQuestions && synthesis.openQuestions.length > 0 ? (
        <Card>
          <CardContent className="space-y-3 p-4 text-sm">
            <h2 className="text-sm font-semibold">仍然开放的问题</h2>
            <ul className="list-disc space-y-1 pl-5 text-xs text-muted-foreground">
              {synthesis.openQuestions.map((q, i) => (
                <li key={i}>{q}</li>
              ))}
            </ul>
          </CardContent>
        </Card>
      ) : null}

      {synthesis.sections && synthesis.sections.length > 0 ? (
        <Card>
          <CardContent className="space-y-3 p-4 text-sm">
            <h2 className="text-sm font-semibold">深度阅读</h2>
            {synthesis.sections.map((s, i) => (
              <section key={i} className="border-l-2 border-primary/30 pl-3">
                <h3 className="mb-1 text-sm font-semibold">{s.title}</h3>
                <p className="whitespace-pre-wrap leading-relaxed text-muted-foreground">{s.content}</p>
              </section>
            ))}
          </CardContent>
        </Card>
      ) : null}

      {issues.length === 0 ? (
        <Card>
          <CardContent className="p-4 text-xs text-muted-foreground">
            暂无活跃热点议题；AI 会在窗口内候选累计足够时自动生成。
          </CardContent>
        </Card>
      ) : null}
    </div>
  );
}

function IssuesPane({
  issues,
  candidateCount,
  viewedAt,
}: {
  issues: IssueRow[];
  candidateCount: number;
  viewedAt: string | null;
}): ReactNode {
  return (
    <Card>
      <CardContent className="space-y-3 p-4 text-sm">
        <h2 className="flex items-center justify-between gap-1.5 text-sm font-semibold">
          <span>活跃热点议题（{issues.length}）</span>
          {viewedAt ? (
            <span className="text-[10px] text-muted-foreground">
              已记录查看 {new Date(viewedAt).toLocaleString('zh-CN')}
            </span>
          ) : null}
        </h2>
        {issues.length === 0 ? (
          <p className="text-xs text-muted-foreground">
            累计 {candidateCount} 候选但尚未触发议题；保持关注，新候选累计后会生成。
          </p>
        ) : (
          <ul className="grid list-none gap-2 p-0">
            {issues.map((issue) => (
              <li key={issue.id} className="rounded-md border border-border bg-card p-3">
                <div className="flex items-center gap-1.5">
                  <Badge
                    className={
                      issue.kind === 'event'
                        ? 'bg-status-running-bg text-status-running-fg'
                        : 'bg-status-failed-bg text-status-failed-fg'
                    }
                  >
                    {issue.kind === 'event' ? '事件' : '问题'}
                  </Badge>
                  <h3 className="text-sm font-medium">{issue.title}</h3>
                  <span className="ml-auto text-[10px] text-muted-foreground">
                    重要度 {Math.round(issue.importanceScore * 100)}%
                  </span>
                </div>
                <p className="mt-1 line-clamp-3 text-xs text-muted-foreground">{issue.proposition}</p>
                <div className="mt-1.5 flex flex-wrap items-center gap-2 text-[10px] text-muted-foreground">
                  <span>首发 {new Date(issue.firstSeenAt).toLocaleDateString('zh-CN')}</span>
                  <span>·</span>
                  <span>最近更新 {new Date(issue.lastSeenAt).toLocaleDateString('zh-CN')}</span>
                  {issue.candidateIds.length > 0 ? (
                    <>
                      <span>·</span>
                      <span>{issue.candidateIds.length} 个关联来源</span>
                    </>
                  ) : null}
                </div>
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}

function ResearchPane({ researchTopics }: { researchTopics: ResearchRow[] }): ReactNode {
  return (
    <Card>
      <CardContent className="space-y-3 p-4 text-sm">
        <h2 className="text-sm font-semibold">相关研究（{researchTopics.length}）</h2>
        {researchTopics.length === 0 ? (
          <p className="text-xs text-muted-foreground">
            还没有关于本专题的已发布研究；从专题发起 AI 调研时会在发布时自动回流。
          </p>
        ) : (
          <ul className="grid list-none gap-2 p-0">
            {researchTopics.map((row) => (
              <li key={row.researchId} className="rounded-md border border-border bg-card p-3">
                <div className="flex items-center gap-1.5">
                  <Link
                    href={`/research/${row.researchId}`}
                    className="text-sm font-medium hover:text-primary hover:underline"
                  >
                    {row.researchTitle}
                  </Link>
                  {row.researchStatus === 'published' ? (
                    <Badge className="bg-status-success-bg text-status-success-fg">已发布</Badge>
                  ) : (
                    <Badge className="bg-muted text-muted-foreground">{row.researchStatus}</Badge>
                  )}
                  <span className="ml-auto text-[10px] text-muted-foreground">
                    {new Date(row.createdAt).toLocaleDateString('zh-CN')}
                  </span>
                </div>
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}

function SourcesPane({
  candidates,
  issues,
}: {
  candidates: CandidateRow[];
  issues: IssueRow[];
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
      {issues.map((issue) => {
        const list = byIssue.map.get(issue.id) ?? [];
        if (list.length === 0) return null;
        return (
          <Card key={issue.id}>
            <CardContent className="space-y-3 p-4 text-sm">
              <h3 className="text-sm font-semibold">{issue.title}</h3>
              <ul className="grid list-none gap-2 p-0">
                {list.slice(0, 5).map((c) => (
                  <SourceRow key={c.summaryId} candidate={c} />
                ))}
              </ul>
              {list.length > 5 ? (
                <p className="text-[11px] text-muted-foreground">
                  还有 {list.length - 5} 条同议题候选，按相关性在下面「近期信号」中查看。
                </p>
              ) : null}
            </CardContent>
          </Card>
        );
      })}

      <Card>
        <CardContent className="space-y-3 p-4 text-sm">
          <h3 className="text-sm font-semibold">近期信号（{byIssue.orphan.length}）</h3>
          {byIssue.orphan.length === 0 ? (
            <p className="text-xs text-muted-foreground">
              所有候选都已关联到热点议题；新增候选会在窗口期归类。
            </p>
          ) : (
            <ul className="grid list-none gap-2 p-0">
              {byIssue.orphan.slice(0, 12).map((c) => (
                <SourceRow key={c.summaryId} candidate={c} />
              ))}
            </ul>
          )}
        </CardContent>
      </Card>
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
  return (
    <Card>
      <CardContent className="space-y-2 p-4 text-sm">
        <h2 className="flex items-center gap-1.5 text-sm font-semibold">
          <CalendarRange className="size-4 text-muted-foreground" /> 趋势
        </h2>
        <p className="text-xs text-muted-foreground">
          聚合窗口：
          {new Date(topic.aggregationWindowStart).toLocaleDateString('zh-CN')} ~{' '}
          {new Date(topic.aggregationWindowEnd).toLocaleDateString('zh-CN')}
        </p>
        <p className="text-xs text-muted-foreground">
          候选 {topic.candidateCount} · 来源 {topic.sourceCount} · 上次同步{' '}
          {topic.lastSyncedAt ? new Date(topic.lastSyncedAt).toLocaleString('zh-CN') : '—'}
        </p>
      </CardContent>
    </Card>
  );
}

function TimelinePane({ candidates }: { candidates: CandidateRow[] }): ReactNode {
  if (candidates.length === 0) {
    return <p className="text-xs text-muted-foreground">暂无候选。</p>;
  }
  const sorted = [...candidates].sort((a, b) => {
    const at = a.publishedAt ? new Date(a.publishedAt).getTime() : 0;
    const bt = b.publishedAt ? new Date(b.publishedAt).getTime() : 0;
    return at - bt;
  });
  return (
    <ol className="grid list-none gap-1.5 p-0 text-xs">
      {sorted.slice(0, 12).map((c) => (
        <li key={c.summaryId} className="flex items-start gap-2">
          <span className="mt-1 inline-block size-1.5 shrink-0 rounded-full bg-primary" />
          <div className="min-w-0 flex-1">
            <p className="font-mono text-[10px] text-muted-foreground">
              {c.publishedAt ? new Date(c.publishedAt).toLocaleDateString('zh-CN') : '—'}
            </p>
            <Link href={`/radar/${c.summaryId}`} className="line-clamp-2 hover:text-primary hover:underline">
              {c.title}
            </Link>
          </div>
        </li>
      ))}
    </ol>
  );
}
