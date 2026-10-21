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

import Tabs from '@mui/material/Tabs';
import Tab from '@mui/material/Tab';
import Paper from '@mui/material/Paper';
import { AppButton as Button } from '@/components/material/AppButton';
import { AppDialog } from '@/components/material/AppDialog';
import { StatCard } from '@/components/domain/StatCard';
import { PageHeader } from '@/components/domain/PageHeader';
import { StatusBadge } from '@/components/domain/StatusBadge';
import { TopicFollowButton } from '@/components/topics/TopicFollowButton';
import { PreviousJudgments } from '@/components/radar/RadarKnowledgeActions';
import { formatSourceType } from '@/lib/radar/source-labels';
import type { TopicCandidateTrendPoint } from '@/lib/topics';
import type { ReactNode } from 'react';
import styles from './topic-detail.module.css';

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

function RetrySynthesisForm({ slug }: { slug: string }) {
  const formRef = useRef<HTMLFormElement>(null);
  const [confirmOpen, setConfirmOpen] = useState(false);

  return (
    <>
      <form ref={formRef} action={`/api/topics/${slug}/synthesis/retry`} method="post">
        <Button type="button" size="small" variant="outlined" onClick={() => setConfirmOpen(true)}>
          重试综述
        </Button>
      </form>
      <AppDialog
        open={confirmOpen}
        onClose={() => setConfirmOpen(false)}
        title="确认重新生成 AI 综述？"
        description="重新生成 AI 综述会消耗模型调用额度,确认继续?"
        actions={(
          <>
            <Button type="button" variant="outlined" onClick={() => setConfirmOpen(false)}>
              取消
            </Button>
            <Button
              type="button"
              onClick={() => {
                setConfirmOpen(false);
                formRef.current?.requestSubmit();
              }}
            >
              确认继续
            </Button>
          </>
        )}
      />
    </>
  );
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
    <div ref={rootRef} className={styles.screen} data-topic-detail>
      <Link href="/topics" className={styles.backLink}>
        <ArrowLeft aria-hidden className={styles.smallIcon} />
        返回专题列表
      </Link>
      <PageHeader
        title={topic.name}
        description={
          <>
            {topic.summary ? <span className={styles.block}>{topic.summary}</span> : null}
            <span className={styles.headerMetadata}>
              相关内容 {topic.candidateCount} · 采集渠道 {topic.sourceCount} · 上次同步{' '}
              {topic.lastSyncedAt
                ? new Date(topic.lastSyncedAt).toLocaleDateString('zh-CN')
                : '待同步'}
            </span>
          </>
        }
        actions={
          <div className={styles.actions}>
            <StatusBadge kind="topicTier" value={topic.tier} />
            <Button component={Link} size="small" variant="contained" startIcon={<Sparkles aria-hidden />}
                href={
                  isAuthenticated
                    ? `/ai-research?topic=${encodeURIComponent(topic.name)}&topicId=${encodeURIComponent(topic.id)}`
                    : `/signin?callbackUrl=${encodeURIComponent(`/ai-research?topic=${topic.name}&topicId=${topic.id}`)}`
                }
              >
                {isAuthenticated ? '开始 AI 调研' : '登录后开始 AI 调研'}
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
      <div className={styles.tabsRoot}>
        <div className={styles.stickyTabs}>
          <Tabs value={tab} onChange={(_, value: TabKey) => handleTabChange(value)} selectionFollowsFocus aria-label="专题详情" className={styles.tabs}>
            {([
              ['overview', '概览', <Sparkles key="overview" aria-hidden />],
              ['issues', `热点议题（${issueTotalCount}）`, <Sparkles key="issues" aria-hidden />],
              ['research', `相关研究（${researchTopics.length}）`, <FileText key="research" aria-hidden />],
              ['sources', `相关内容（${topic.candidateCount}）`, <ListTree key="sources" aria-hidden />],
            ] as const).map(([value, label, icon]) => <Tab key={value} value={value} label={label} icon={icon} iconPosition="start" className={styles.tab} id={`topic-${topic.id}-${value}-tab`} aria-controls={`topic-${topic.id}-${value}-panel`} />)}
          </Tabs>
        </div>

        <TopicPane topicId={topic.id} value="overview" active={tab}>
          <PreviousJudgments topicId={topic.id} enabled={isAuthenticated} />
          <OverviewPane
            topic={topic}
            issues={issues}
            issueTotalCount={issueTotalCount}
            candidates={candidates}
            isAdmin={isAdmin}
          />
        </TopicPane>
        <TopicPane topicId={topic.id} value="issues" active={tab}>
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
        </TopicPane>
        <TopicPane topicId={topic.id} value="research" active={tab}>
          <ResearchPane
            topicName={topic.name}
            topicId={topic.id}
            researchTopics={researchTopics}
            isAuthenticated={isAuthenticated}
          />
        </TopicPane>
        <TopicPane topicId={topic.id} value="sources" active={tab}>
          <SourcesPane
            candidates={candidates}
            candidateTotalCount={topic.candidateCount}
            sourceCount={topic.sourceCount}
            sourceIssues={sourceIssues}
          />
        </TopicPane>

      </div>
    </div>
  );
}

function TopicPane({ topicId, value, active, children }: { topicId: string; value: TabKey; active: TabKey; children: ReactNode }) {
  const selected = active === value;
  return (
    <div
      role="tabpanel"
      id={`topic-${topicId}-${value}-panel`}
      aria-labelledby={`topic-${topicId}-${value}-tab`}
      tabIndex={selected ? 0 : -1}
      hidden={!selected}
      className={styles.panel}
    >
      {selected ? children : null}
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
      <Paper variant="outlined" className={styles.paper}>
        <div className={styles.paddedStack}>
          {isAdmin ? (
            <p className={styles.error}>
              综述生成失败（{topic.synthesisErrorCode}）：{topic.synthesisErrorMessage}
            </p>
          ) : (
            <p className={styles.bodySecondary}>AI 综述暂时不可用,请稍后再试。</p>
          )}
          {topic.lastSynthesisSuccessAt ? (
            <p className={styles.caption}>
              上次成功更新：{new Date(topic.lastSynthesisSuccessAt).toLocaleString('zh-CN')}
            </p>
          ) : null}
          {isAdmin ? (
            <RetrySynthesisForm slug={topic.slug} />
          ) : null}
        </div>
      </Paper>
    );
  }
  if (!synthesis || !synthesis.tldr) {
    return (
      <div className={styles.overview}>
        <section className={styles.pendingSection}>
          <div className={styles.between}>
            <div className={styles.shrink}>
              <h2 className={styles.sectionTitle}>
                <Sparkles aria-hidden className={styles.primaryIcon} /> AI 综述暂未就绪
              </h2>
              <SynthesisPendingNotice
                hasError={Boolean(topic.synthesisErrorMessage)}
                lastSuccessAt={topic.lastSynthesisSuccessAt}
              />
            </div>
            {isAdmin ? (
              <RetrySynthesisForm slug={topic.slug} />
            ) : null}
          </div>
          <div className={styles.stats}>
            <StatCard label="相关内容" value={topic.candidateCount} density="compact" />
            <StatCard label="活跃议题" value={issueTotalCount} density="compact" />
            <StatCard label="采集渠道" value={topic.sourceCount} density="compact" />
          </div>
        </section>

        <RecentIssuesPreview topic={topic} issues={issues} issueTotalCount={issueTotalCount} />
        <div className={styles.twoColumns}>
          <TrendPane topic={topic} />
          <Paper variant="outlined" className={styles.paper}>
            <div className={styles.padded}>
              <h2 className={styles.panelTitle}>
                <ListTree aria-hidden className={styles.icon} />
                时间线
              </h2>
              <TimelinePane candidates={candidates} />
            </div>
          </Paper>
        </div>
      </div>
    );
  }
  /* 综述改成长文块 + 嵌入式 section divider,只在「事实审核」保留 Card */
  return (
    <div className={styles.overview}>
      <section>
        <h2 className={styles.sectionTitle}>
          <Sparkles className={styles.icon} aria-hidden /> 一句话概要
        </h2>
        <p className={styles.tldr}>{synthesis.tldr}</p>
        {topic.lastSynthesisSuccessAt ? (
          <p className={styles.updated}>
            最近更新：{new Date(topic.lastSynthesisSuccessAt).toLocaleString('zh-CN')}
          </p>
        ) : null}
        {referenceCount > 0 ? (
          <Link
            href="#topic-evidence"
            className={styles.evidenceJump}
          >
            <FileText aria-hidden className={styles.smallIcon} />
            查看综述依据（{referenceCount}）
          </Link>
        ) : null}
      </section>

      <RecentIssuesPreview
        topic={topic}
        issues={issues}
        issueTotalCount={issueTotalCount}
      />

      <div className={styles.twoColumns}>
        <TrendPane topic={topic} />
        <Paper variant="outlined" className={styles.paper}>
          <div className={styles.padded}>
            <h2 className={styles.panelTitle}>
              <ListTree aria-hidden className={styles.icon} />
              时间线
            </h2>
            <TimelinePane candidates={candidates} />
          </div>
        </Paper>
      </div>

      {hasKeyChanges ? (
        <section id="topic-evidence" className={styles.evidenceSection}>
          <div className={styles.headingRow}>
            <h2 className={styles.sectionTitle}>为什么重要</h2>
            {referenceCount > 0 ? (
              <span className={styles.caption}>
                {referenceCount} 条可回溯来源
              </span>
            ) : null}
          </div>
          <ul className={styles.spacedList}>
            {keyChanges.map((kc, i) => (
              <li key={i} className={styles.itemCard}>
                <p className={styles.fieldTitle}>{kc.title}</p>
                <p className={styles.secondaryParagraph}>{kc.whyItMatters}</p>
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
        <details className={styles.disclosure}>
          <summary className={styles.disclosureSummary}>
            <span className={styles.inline}>
              <ChevronRight aria-hidden className={styles.chevron} />
              子方向
            </span>
          </summary>
          <ul className={styles.detailList}>
            {synthesis.subtopics.map((st, i) => (
              <li key={i} className={styles.dividedItem}>
                <p className={styles.fieldTitle}>{st.title}</p>
                <p className={styles.secondaryParagraph}>{st.summary}</p>
              </li>
            ))}
          </ul>
        </details>
      ) : null}

      {synthesis.openQuestions && synthesis.openQuestions.length > 0 ? (
        <details className={styles.disclosure}>
          <summary className={styles.disclosureSummary}>
            <span className={styles.inline}>
              <ChevronRight aria-hidden className={styles.chevron} />
              仍然开放的问题
            </span>
          </summary>
          <ul className={styles.questions}>
            {synthesis.openQuestions.map((q, i) => (
              <li key={i}>{q}</li>
            ))}
          </ul>
        </details>
      ) : null}

      {synthesis.sections && synthesis.sections.length > 0 ? (
        <details className={styles.disclosure}>
          <summary className={styles.disclosureSummary}>
            <span className={styles.inline}>
              <ChevronRight aria-hidden className={styles.chevron} />
              深度阅读
            </span>
          </summary>
          <div className={styles.readingSections}>
            {synthesis.sections.map((s, i) => (
              <section key={i} className={styles.readingSection}>
                <h3 className={styles.readingTitle}>{s.title}</h3>
                <p className={styles.reading}>{s.content}</p>
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
        <Paper variant="outlined" className={styles.paper}>
          <div className={styles.paddedQuiet}>
            {NO_ACTIVE_ISSUE_COPY(topic.candidateCount)}
          </div>
        </Paper>
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
    <div className={styles.notice}>
      <p className={styles.bodySecondary}>
        {hasError
          ? '最近一次生成没有成功。你仍然可以先阅读热点议题和原始内容。'
          : slow
            ? '综述生成时间比预期长。你仍然可以先阅读热点议题和时间线，稍后刷新查看结果。'
            : '综述正在准备中。先从下方的热点议题和时间线开始，不必等待整篇综述。'}
      </p>
      {lastSuccessAt ? (
        <p className={styles.caption}>
          最近成功更新：{new Date(lastSuccessAt).toLocaleString('zh-CN')}
        </p>
      ) : null}
      {slow ? (
        <div className={styles.refreshRow}>
          <span>等待超过 8 秒</span>
          <Button type="button" size="small" variant="outlined" onClick={() => router.refresh()}>
            <RefreshCw aria-hidden />
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
      <div className={styles.headingRow}>
        <div>
          <h2 id="featured-topic-issues" className={styles.sectionTitle}>
            重点议题
          </h2>
          <p className={styles.previewHint}>按重要度展示</p>
        </div>
        <Link
          href={`/topics/${encodeURIComponent(topic.slug)}?tab=issues`}
          className={styles.textLink}
        >
          查看全部 {issueTotalCount} 个议题
        </Link>
      </div>
      <ul className={styles.spacedList}>
        {issues.slice(0, 3).map((issue) => (
          <li key={issue.id} className={styles.dividedItem}>
            <div className={styles.metadata}>
              <span>{issue.kind === 'event' ? '事件' : '问题'}</span>
              <span>最近更新 {new Date(issue.lastSeenAt).toLocaleDateString('zh-CN')}</span>
              <span>{issue.candidateIds.length} 条关联内容</span>
            </div>
            <h3 className={styles.previewTitle}>{issue.title}</h3>
            <p className={styles.previewSummary}>{issue.proposition}</p>
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
    <details className={styles.evidenceDisclosure}>
      <summary className={styles.evidenceSummary}>
        依据 {rows.length} 条来源
      </summary>
      <ul className={styles.evidenceList}>
        {rows.map((row) => (
          <li key={row.summaryId}>
            <Link href={`/radar/${row.summaryId}`} className={styles.textLink}>
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
    <section id="topic-evidence" className={styles.evidenceSection}>
      <div className={styles.headingRow}>
        <h2 className={styles.sectionTitle}>综述依据</h2>
        <span className={styles.caption}>
          {rows.length} 条可回溯来源
        </span>
      </div>
      <ul className={styles.evidenceList}>
        {rows.map((reference) => (
          <li key={reference.summaryId}>
            <Link href={`/radar/${reference.summaryId}`} className={styles.textLink}>
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
    <section className={styles.stack}>
      <div className={styles.stack8}>
        <div className={styles.headingRow}>
          <h2 className={styles.sectionTitle}>活跃热点议题</h2>
          {followed && issueUnreadCount > 0 && !viewedAt ? (
            <Button
              type="button"
              variant="outlined"
              size="small"
              className={styles.control}
              onClick={onMarkViewed}
              disabled={markingViewed}
            >
              {markingViewed ? <Loader2 aria-hidden className={styles.spin} /> : <CheckCheck aria-hidden />}
              {markingViewed ? '标记中…' : '标记全部已读'}
            </Button>
          ) : null}
          {viewedAt ? (
            <span className={styles.caption}>
              已标记为已读 {new Date(viewedAt).toLocaleString('zh-CN')}
            </span>
          ) : null}
        </div>
        <div className={styles.metadata}>
          <span>已显示 {rows.length} 条，共 {issueTotalCount} 条</span>
          <span>按重要度排序</span>
          {unreadCount > 0 ? <span className={styles.primary}>{unreadCount} 个议题在上次查看后有更新</span> : null}
        </div>
      </div>
      {viewError ? <p className={styles.error}>{viewError}</p> : null}
      {rows.length === 0 ? (
        <p className={styles.empty}>
          {NO_ACTIVE_ISSUE_COPY(candidateCount)}
        </p>
      ) : (
        <ul className={styles.list}>
          {rows.map((issue) => (
            <li key={issue.id} className={styles.itemCard}>
              <div className={styles.issueHeader}>
                <StatusBadge kind="issue" value={issue.kind === 'event' ? 'info' : 'error'} label={issue.kind === 'event' ? '事件' : '问题'} />
                <h3 className={styles.issueTitle}>{issue.title}</h3>
              </div>
              <p className={styles.issueProposition}>{issue.proposition}</p>
              <div className={styles.itemMetadata}>
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
      {loadError ? <p className={styles.error}>{loadError}</p> : null}
      {hasMore ? (
        <Button type="button" variant="outlined" size="small" className={styles.control} onClick={() => void loadMore()} disabled={loadingMore}>
          {loadingMore ? <Loader2 aria-hidden className={styles.spin} /> : null}
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
    <section className={styles.stack}>
      <h2 className={styles.sectionTitle}>相关研究（{researchTopics.length}）</h2>
      {researchTopics.length === 0 ? (
        <div className={styles.emptyStack}>
          <p className={styles.caption}>
            暂无相关研究或你已保存的判断。
          </p>
          <Button component={Link} size="small" variant="contained" startIcon={<Sparkles aria-hidden />}
              href={
                isAuthenticated
                  ? researchHref
                  : `/signin?callbackUrl=${encodeURIComponent(researchHref)}`
              }
            >
              {isAuthenticated ? '从本专题开始调研' : '登录后开始调研'}
          </Button>
        </div>
      ) : (
        <ul className={styles.list}>
          {researchTopics.map((row) => (
            <li key={row.researchId} className={styles.itemCard}>
              <div className={styles.rowHeader}>
                <Link
                  href={`/researches/${row.researchId}`}
                  className={styles.researchLink}
                >
                  {row.researchTitle}
                </Link>
                <StatusBadge kind="research" value={row.researchStatus} label={row.researchStatus === 'published' ? undefined : '仅本人'} />
                <span className={styles.caption}>
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
    <div className={styles.stack16}>
      <p className={styles.caption}>
        共 {candidateTotalCount} 条可查看内容，来自 {sourceCount} 个采集渠道
        {candidates.length < candidateTotalCount ? `；当前已加载最近 ${candidates.length} 条` : '；已全部加载'}。
      </p>
      {sourceIssues.map((issue) => {
        const list = byIssue.map.get(issue.id) ?? [];
        if (list.length === 0) return null;
        return (
          <section key={issue.id} className={styles.stack}>
            <h3 className={styles.sectionTitle}>{issue.title}</h3>
            <ul className={styles.list}>
              {list.map((c) => (
                <SourceRow key={c.summaryId} candidate={c} />
              ))}
            </ul>
          </section>
        );
      })}

      <section className={styles.stack}>
        <h3 className={styles.sectionTitle}>
          未归入议题的{candidates.length < candidateTotalCount ? '已加载' : ''}近期信号（{byIssue.orphan.length}）
        </h3>
        {byIssue.orphan.length === 0 ? (
          <p className={styles.empty}>
            所有相关内容都已关联到热点议题；新增内容会在窗口期归类。
          </p>
        ) : (
          <ul className={styles.list}>
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
        className={styles.sourceLink}
      >
        <p className={styles.sourceTitle}>{candidate.title}</p>
        <p className={styles.previewHint}>
          {formatSourceType(candidate.originalKind).short} ·{' '}
          {candidate.publishedAt ? new Date(candidate.publishedAt).toLocaleDateString('zh-CN') : '—'}
          {candidate.tags.length > 0 ? ` · ${candidate.tags.slice(0, 3).join(', ')}` : ''}
        </p>
        {candidate.interpretation ? (
          <p className={styles.previewSummary}>{candidate.interpretation}</p>
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
    <Paper variant="outlined" className={styles.paper}>
      <div className={styles.paddedStack}>
        <h2 className={styles.sectionTitle}>
          <CalendarRange aria-hidden className={styles.icon} /> 趋势
        </h2>
        <p className={styles.caption}>
          聚合窗口：
          {new Date(topic.aggregationWindowStart).toLocaleDateString('zh-CN')} ~{' '}
          {new Date(topic.aggregationWindowEnd).toLocaleDateString('zh-CN')}
        </p>
        <TrendSparkline points={trend} />
        <p className={styles.caption}>
          过去 {trend.length} 天新增 {totalInWindow} 条相关内容
          {peak && peak.count > 0 ? `，单日峰值 ${peak.count} 条（${peak.date}）` : ''}
        </p>
      </div>
    </Paper>
  );
}

function TrendSparkline({ points }: { points: TopicCandidateTrendPoint[] }): ReactNode {
  if (points.length === 0) {
    return <p className={styles.caption}>暂无趋势数据。</p>;
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
    <div className={styles.stack4}>
      <svg
        role="img"
        aria-label={`过去 ${points.length} 天相关内容趋势`}
        viewBox={`0 0 ${width} ${height}`}
        preserveAspectRatio="none"
        className={styles.sparkline}
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
      <div className={styles.chartDates}>
        <span>起 {formatDate(firstDate)}</span>
        <span>止 {formatDate(lastDate)}</span>
      </div>
    </div>
  );
}

function TimelinePane({ candidates }: { candidates: CandidateRow[] }): ReactNode {
  if (candidates.length === 0) {
    return <p className={styles.caption}>暂无相关内容。</p>;
  }
  /* 服务端已按 addedAt desc 排序;客户端仅按 publishedAt desc 排序,
     null 的候选(尚未发布) 排到末尾,而不是最前 */
  const sorted = [...candidates].sort((a, b) => {
    const at = a.publishedAt ? new Date(a.publishedAt).getTime() : -Infinity;
    const bt = b.publishedAt ? new Date(b.publishedAt).getTime() : -Infinity;
    return bt - at;
  });
  return (
    <div className={styles.stack8}>
      <p className={styles.caption}>
        最近显示 {Math.min(sorted.length, 12)} 条，共 {sorted.length} 条已加载内容。
      </p>
      <ol aria-label="按发布时间排序的近期相关内容" className={styles.timeline}>
          {sorted.slice(0, 12).map((c) => (
            <li key={c.summaryId} className={styles.timelineRow}>
              <span className={styles.timelineDot} aria-hidden />
              <div className={styles.grow}>
                <p className={styles.timelineDate}>
                  <time>{c.publishedAt ? new Date(c.publishedAt).toLocaleDateString('zh-CN') : '待发布'}</time>
                </p>
                <Link href={`/radar/${c.summaryId}`} className={styles.timelineLink}>
                  {c.title}
                </Link>
              </div>
            </li>
          ))}
      </ol>
    </div>
  );
}
