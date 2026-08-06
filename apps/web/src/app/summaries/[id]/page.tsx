'use client';

import { useParams } from 'next/navigation';

import { useQuery } from '@tanstack/react-query';
import Link from 'next/link';
import { useEffect, useRef, useState } from 'react';
import { AlertTriangle, ArrowLeft, ExternalLink } from 'lucide-react';

import { EmptyState } from '@/components/EmptyState';
import { CommentSection } from '@/components/CommentSection';
import { TagChip, TagList } from '@/components/domain/TagChip';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { useCurrentUser } from '@/lib/auth/client';
import { isHttpUrl } from '@/lib/external-url';
import MarkdownContent from '@/components/MarkdownContent';
import { BackToSearchButton } from '@/components/domain/BackToSearchButton';
import { formatSourceType } from '@/lib/radar/source-labels';

interface SummaryDetail {
  id: string;
  title: string;
  body: string;
  interpretation: string | null;
  url: string;
  tags: string[];
  contentOrigin: string;
  summaryDate: string;
  publishedAt: string | null;
  crawledAt: string;
  source: string;
  sharedBy: { id: string; name: string } | null;
}

interface DigestRankedItem {
  summaryId: string | null;
  title: string;
  url: string;
  radarUrl: string | null;
  oneLineReason: string;
}

interface DigestArticleData {
  summaryId: string;
  date: string;
  title: string;
  publishedAt: string | null;
  tldr: string;
  sections: Array<{ title: string; body: string }>;
  // highlights 由后端生成时填充，但前端不再渲染（与 ranked + sections 内容重叠）。
  // 类型保留以便 query 类型推断不报错；前端代码不应再读此字段。
  highlights: Array<{ url: string; title: string; summary: string }>;
  ranked: DigestRankedItem[];
  sourcesUsed: string[];
  candidateCount: number;
  narrativeDegraded: boolean;
  model: string | null;
  generatedAt: string | null;
}

/**
 * 详情页。
 *
 * 验收：
 *   - 外部链接 `rel="noopener noreferrer"` + `target="_blank"`
 *   - 标题、摘要、标签、原文 URL、来源类型、抓取时间
 *   - 预留评论 / 追问区域（本周 W3+ 才实现交互）
 *   - 30s 前台 + 50% 滚动双条件 → POST /api/events/detail-read
 */
export default function SummaryDetailPage() {
  const params = useParams<{ id: string }>();
  // 日期段（YYYY-MM-DD）走日报文章；UUID 走单条摘要详情。
  const isDate = /^\d{4}-\d{2}-\d{2}$/u.test(params.id);
  const q = useQuery<SummaryDetail>({
    queryKey: ['summary', params.id],
    enabled: !isDate,
    queryFn: async () => {
      const r = await fetch(`/api/summaries/${params.id}`, { cache: 'no-store' });
      if (!r.ok) {
        const err = await r.json().catch(() => ({ message: '加载失败' }));
        throw new Error(err.message ?? '加载失败');
      }
      return (await r.json()) as SummaryDetail;
    },
  });

  if (isDate) {
    return <DigestDatePage date={params.id} />;
  }

  return (
    <div className="mx-auto max-w-measure">
      <BackToSearchButton />
      <Button asChild variant="link" size="xs" className="mb-2 h-auto p-0">
        <Link href="/summaries">
          <ArrowLeft />
          返回摘要列表
        </Link>
      </Button>

      {q.isLoading ? (
        <DetailSkeleton />
      ) : q.isError ? (
        <EmptyState title="加载失败" description={String((q.error as Error).message)} />
      ) : q.data ? (
        <DetailBody data={q.data} />
      ) : null}
    </div>
  );
}

/** 详情页骨架屏 —— 日报与单条摘要共用。 */
function DetailSkeleton() {
  return (
    <div className="space-y-3">
      <Skeleton className="h-8 w-2/3" />
      <Skeleton className="h-4 w-48" />
      <Skeleton className="h-24 w-full" />
      <Skeleton className="h-40 w-full" />
    </div>
  );
}

function DigestDatePage({ date }: { date: string }) {
  const q = useQuery<{ date: string; item: DigestArticleData }>({
    queryKey: ['digest', date],
    queryFn: async () => {
      const r = await fetch(`/api/summaries?date=${date}`, { cache: 'no-store' });
      if (!r.ok) {
        const err = await r.json().catch(() => ({ message: '加载失败' }));
        throw new Error(err.message ?? '加载失败');
      }
      return (await r.json()) as { date: string; item: DigestArticleData };
    },
  });

  return (
    <div className="mx-auto max-w-measure">
      <Button asChild variant="link" size="xs" className="mb-2 h-auto p-0">
        <Link href="/summaries">
          <ArrowLeft />
          返回日报列表
        </Link>
      </Button>

      {q.isLoading ? (
        <DetailSkeleton />
      ) : q.isError ? (
        <EmptyState title="加载失败" description={String((q.error as Error).message)} />
      ) : q.data ? (
        <DigestArticle data={q.data.item} />
      ) : null}
    </div>
  );
}

function DigestArticle({ data }: { data: DigestArticleData }) {
  const me = useCurrentUser();
  const fmt = (iso: string | null) =>
    iso ? new Date(iso).toISOString().replace('T', ' ').slice(0, 16) + ' UTC' : '—';
  const sourceLabels = [...new Set(data.sourcesUsed.map((source) => formatSourceType(source).short))];

  return (
    <article>
      <h1 className="text-2xl font-semibold leading-tight tracking-normal">{data.title}</h1>
      <div className="mt-2 text-xs text-muted-foreground">
        <span className="font-mono">{data.date}</span>
        {' · '}发布 <span className="font-mono">{fmt(data.publishedAt)}</span>
        {' · '}
        纳入综述 {data.candidateCount} 条
        {' · '}来源 {sourceLabels.join('、') || '—'}
      </div>

      {data.narrativeDegraded ? (
        <p className="mt-3 flex items-start gap-2 rounded-r-md border-l-2 border-l-status-partial-fg bg-status-partial-bg px-3 py-2 text-sm text-status-partial-fg">
          <AlertTriangle className="mt-0.5 size-4 shrink-0" />
          本次摘要生成降级为候选列表，未生成叙事性文章。
        </p>
      ) : null}

      {data.tldr ? (
        <blockquote className="my-4 rounded-r-md border-l-2 border-l-primary bg-muted/50 px-4 py-3 text-[15px] leading-relaxed">
          {data.tldr}
        </blockquote>
      ) : null}

      {data.sections.length > 0 ? (
        <section className="mb-5">
          <h2 className="mb-2 text-base font-semibold">分类综述</h2>
          <div className="space-y-3">
            {data.sections.map((sec) => (
              <div key={sec.title}>
                <h3 className="mb-1 text-sm font-semibold">{sec.title}</h3>
                <p className="text-[15px] leading-relaxed">{sec.body}</p>
              </div>
            ))}
          </div>
        </section>
      ) : null}

      {data.ranked.length > 0 ? (
        <section className="mb-6">
          <h2 className="mb-2 text-base font-semibold">今日榜单</h2>
          <ol className="list-decimal space-y-2.5 pl-5">
            {data.ranked.map((item, index) => (
              <li key={`${item.url}-${index}`}>
                {item.radarUrl ? (
                  <Link href={item.radarUrl} className="font-medium text-primary hover:underline">
                    {item.title}
                  </Link>
                ) : (
                  <a
                    href={item.url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex items-center gap-1 font-medium text-primary hover:underline"
                  >
                    {item.title}
                    <ExternalLink className="size-3" />
                  </a>
                )}
                <p className="mt-0.5 text-sm text-muted-foreground">{item.oneLineReason}</p>
              </li>
            ))}
          </ol>
        </section>
      ) : null}

      {data.model || data.generatedAt ? (
        <p className="border-t border-border pt-2.5 font-mono text-xs text-muted-foreground">
          {data.generatedAt ? `生成 ${fmt(data.generatedAt)}` : ''}
          {data.model ? ` · ${data.model}` : ''}
        </p>
      ) : null}

      <CommentSection
        targetType="summary"
        targetId={data.summaryId}
        currentUserId={me.data?.id ?? null}
        currentUserRole={me.data?.role ?? null}
      />
    </article>
  );
}

function DetailBody({ data }: { data: SummaryDetail }) {
  // 详情可见后开始跟踪指标；卸载 / 离开时停止
  const articleRef = useRef<HTMLElement | null>(null);
  const eventState = useDetailReadTracker(data.id, 'summary', articleRef);

  return (
    <article ref={articleRef}>
      <h1 className="text-2xl font-semibold leading-tight tracking-normal">{data.title}</h1>
      <Meta data={data} />

      {(() => {
        const displayTags = data.tags.filter((t) => {
          if (t === 'must_read' || t.startsWith('tier_') || t.startsWith('profile_') || t.startsWith('veto_') || t.startsWith('risk_')) return false;
          if (t === 'rss' || t === 'api' || t === 'web' || t === 'github' || t === 'tracked' || t === 'repo_digest' || t === 'pr_soft') return false;
          return true;
        });
        if (displayTags.length === 0) return null;
        return (
          <TagList className="my-3">
            {displayTags.map((t) => (
              <TagChip key={t}>{t}</TagChip>
            ))}
          </TagList>
        );
      })()}

      {data.interpretation ? (
        <p className="my-3 rounded-r-md border-l-2 border-l-primary bg-muted/50 px-4 py-3 text-[15px] leading-7">
          <span className="mr-1.5 text-xs text-muted-foreground">AI 一句话解读：</span>
          {data.interpretation}
        </p>
      ) : null}

      {data.body && data.body !== data.interpretation ? (
        <section className="my-8" aria-labelledby="summary-body-title">
          <h2 id="summary-body-title" className="mb-3 text-xs font-semibold uppercase tracking-[0.12em] text-muted-foreground">正文</h2>
          <MarkdownContent content={data.body} className="text-[15px]" />
        </section>
      ) : null}

      {isHttpUrl(data.url) ? (
        <Button asChild size="sm">
          <a href={data.url} target="_blank" rel="noopener noreferrer">
            打开原文
            <ExternalLink />
          </a>
        </Button>
      ) : null}

      {/* W8 评论区 */}
      <CommentSectionWrapper
        summaryId={data.id}
        indicator={
          <>
            <strong className="font-medium text-foreground">阅读追踪</strong>
            <p className="mt-1">停留 ≥30 秒且滚动 ≥50% 时自动上报一次阅读完成事件。</p>
            <p className="mt-1 text-xs">
              状态：{eventState.label}
              {eventState.submitted ? ' · 已上报' : eventState.eligible ? ' · 待提交' : ''}
            </p>
          </>
        }
      />
    </article>
  );
}

function CommentSectionWrapper({
  summaryId,
  indicator,
}: {
  summaryId: string;
  indicator: React.ReactNode;
}) {
  const me = useCurrentUser();
  return (
    <>
      {/* ⚠️ e2e 契约：aria-label="阅读追踪" */}
      <section
        className="mt-8 rounded-lg border border-dashed border-border bg-muted/40 p-4 text-sm text-muted-foreground"
        aria-label="阅读追踪"
      >
        {indicator}
      </section>
      <CommentSection
        targetType="summary"
        targetId={summaryId}
        currentUserId={me.data?.id ?? null}
        currentUserRole={me.data?.role ?? null}
      />
    </>
  );
}

function Meta({ data }: { data: SummaryDetail }) {
  const fmt = (iso: string | null) =>
    iso ? new Date(iso).toISOString().replace('T', ' ').slice(0, 16) + ' UTC' : '—';
  return (
    <div className="mt-2 text-xs text-muted-foreground">
      来源 <code className="rounded bg-muted px-1 font-mono">{data.contentOrigin}</code>
      {' · '}抓取时间 <span className="font-mono">{fmt(data.crawledAt)}</span>
      {' · '}发布日期 <span className="font-mono">{data.summaryDate}</span>
      {data.publishedAt ? ` · 发布时间 ${fmt(data.publishedAt)}` : ''}
      {data.sharedBy ? ` · 分享人 ${data.sharedBy.name}` : ''}
    </div>
  );
}

/**
 * 跟踪详情页停留 / 滚动，达成条件后提交 detail_read_completed。
 *
 * 返回仅用于 UI 显示；不阻塞。
 *
 * 状态机：
 *   idle → foregroundActive → eligible (≥30s 且 ≥50%) → submit → done
 *   visibilitychange / pagehide → pause / cancel submit
 */
function useDetailReadTracker(
  entityId: string,
  entityType: 'summary' | 'research',
  articleRef: React.RefObject<HTMLElement | null>,
): { label: string; submitted: boolean; eligible: boolean } {
  const [state, setState] = useState<{
    label: string;
    submitted: boolean;
    eligible: boolean;
  }>({ label: '跟踪中…', submitted: false, eligible: false });

  useEffect(() => {
    let cancelled = false;
    let submitted = false;
    let foregroundMs = 0;
    let maxScrollPercent = 0;
    let lastTick = Date.now();
    let tickHandle: ReturnType<typeof setInterval> | null = null;
    let eligible = false;

    function recompute() {
      const seconds = Math.floor(foregroundMs / 1000);
      const secOk = seconds >= 30;
      const scrollOk = maxScrollPercent >= 50;
      const isEligible = secOk && scrollOk;
      if (isEligible && !eligible) {
        eligible = true;
        setState((s) => ({ ...s, eligible: true, label: `已满足条件（停留 ${seconds}s · 滚动 ${maxScrollPercent.toFixed(0)}%）` }));
      }
      if (!submitted && isEligible) {
        submit();
      } else if (!isEligible) {
        setState((s) => ({ ...s, label: `跟踪中（停留 ${seconds}s · 滚动 ${maxScrollPercent.toFixed(0)}%）` }));
      }
    }

    function tick() {
      if (document.visibilityState !== 'visible') {
        lastTick = Date.now();
        return;
      }
      const now = Date.now();
      foregroundMs += now - lastTick;
      lastTick = now;
      // 重新计算滚动比例（窗口滚动 + 文章本体滚动都算）
      const scrollY = window.scrollY + window.innerHeight;
      const maxY = document.documentElement.scrollHeight;
      const pct = maxY > 0 ? Math.min(100, (scrollY / maxY) * 100) : 0;
      if (pct > maxScrollPercent) maxScrollPercent = pct;
      recompute();
    }

    function onVisibility() {
      const now = Date.now();
      if (document.visibilityState === 'visible') {
        lastTick = now;
      } else {
        foregroundMs += now - lastTick;
        lastTick = now;
        recompute();
      }
    }

    function onScroll() {
      const scrollY = window.scrollY + window.innerHeight;
      const maxY = document.documentElement.scrollHeight;
      const pct = maxY > 0 ? Math.min(100, (scrollY / maxY) * 100) : 0;
      if (pct > maxScrollPercent) maxScrollPercent = pct;
      if (eligible && !submitted) {
        // 滚动追加达 50% 也立即触发
        recompute();
      }
    }

    async function submit() {
      if (submitted || cancelled) return;
      const seconds = Math.floor(foregroundMs / 1000);
      const scroll = Math.round(maxScrollPercent);
      const idempotencyKey = cryptoUuid();
      try {
        const r = await fetch('/api/events/detail-read', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            entityType,
            entityId,
            foregroundSeconds: seconds,
            scrollPercent: scroll,
            idempotencyKey,
          }),
        });
        if (cancelled) return;
        if (r.ok) {
          const body = await r.json().catch(() => ({}));
          submitted = true;
          setState((s) => ({
            ...s,
            submitted: !body.deduplicated,
            label: body.deduplicated ? '本周已记录过同一阅读' : '已上报',
          }));
        } else {
          setState((s) => ({ ...s, label: '上报失败，可忽略（不阻断阅读）' }));
        }
      } catch {
        setState((s) => ({ ...s, label: '上报失败，可忽略（不阻断阅读）' }));
      }
    }

    // 1s 节奏 tick；scroll 事件补帧
    lastTick = Date.now();
    tickHandle = setInterval(tick, 1000);
    document.addEventListener('visibilitychange', onVisibility);
    window.addEventListener('scroll', onScroll, { passive: true });
    window.addEventListener('pagehide', () => {
      cancelled = true;
    });

    return () => {
      cancelled = true;
      if (tickHandle) clearInterval(tickHandle);
      document.removeEventListener('visibilitychange', onVisibility);
      window.removeEventListener('scroll', onScroll);
      // 读 articleRef.current 仅用于调试；避免 lint 警告
      void articleRef;
    };
  }, [entityId, entityType, articleRef]);

  return state;
}

function cryptoUuid(): string {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const g: any = globalThis;
  if (g.crypto?.randomUUID) return g.crypto.randomUUID();
  const rnd = () => Math.floor(Math.random() * 0x10000).toString(16).padStart(4, '0');
  return `${rnd()}${rnd()}-${rnd()}-4${rnd().slice(1)}-${rnd()}-${rnd()}${rnd()}${rnd()}`;
}
