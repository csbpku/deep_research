'use client';

// /ai-research —— 对话式调研工作区 + 调研历史。
//
// ⚠️ e2e 契约：
//   - form 上的 data-ai-research-form 属性
//   - aria-label="AI 调研对话输入"
//   - 正文含 /AI 调研/
//   - LastSubmittedBanner 的 aria-label="关闭"

import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { useQuery } from '@tanstack/react-query';
import { Suspense, useEffect, useState } from 'react';

import {
  AlertTriangle,
  CheckCircle2,
  FolderOpen,
  Info,
  Loader2,
} from 'lucide-react';

import { EmptyState } from '@/components/EmptyState';
import { PageHeader } from '@/components/domain/PageHeader';
import { SectionCard } from '@/components/domain/SectionCard';
import { StatusBadge } from '@/components/domain/StatusBadge';
import { Button } from '@/components/ui/button';
import { Progress } from '@/components/ui/progress';
import { Skeleton } from '@/components/ui/skeleton';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { LastSubmittedBanner } from '@/components/home/LastSubmittedBanner';
import { cn } from '@/lib/utils';
import { progressPct } from '@/lib/ai-progress';
import { writeLastSubmitted } from '@/lib/last-submitted';
import { friendlyMessage } from '@/lib/errors/friendly';
import { toApiHttpError } from '@/lib/errors/api-error';
import { retryOnceAi } from '@/lib/errors/friendly';
import { AiResearchConversation } from '@/components/ai-research/AiResearchConversation';
import { AiResearchConversationSidebar } from '@/components/ai-research/AiResearchConversationSidebar';

// ─── 调研历史 ───

interface HistoryItem {
  jobId: string;
  topic: string;
  status: string;
  finalStatus?: string | null;
  currentStep: string | null;
  reportType: string;
  sourcePolicy: string;
  costCents: number;
  draftResearchId: string | null;
  publishedResearchId: string | null;
  errorCode: string | null;
  createdAt: string | null;
}

type HistoryFilter = 'all' | 'running' | 'published' | 'failed' | 'cancelled';

const FILTERS: Array<{ key: HistoryFilter; label: string }> = [
  { key: 'all', label: '全部' },
  { key: 'running', label: '进行中' },
  { key: 'published', label: '已发布' },
  { key: 'failed', label: '失败' },
  { key: 'cancelled', label: '已取消' },
];

const REPORT_TYPE_LABEL: Record<string, string> = {
  research_report: '研究报告',
  summary_brief: '轻量摘要',
  slides: 'Slides 演示稿',
};

const STEP_LABEL: Record<string, string> = {
  plan: '规划研究问题',
  search: '检索与抓取',
  compress: '压缩证据',
  analyze: '分析与对比',
  write: '写作草稿',
  review: '事实审核',
};

/** mockup tab → server-side status filter. 已发布在客户端二次过滤。 */
function filterToQuery(key: HistoryFilter): string {
  switch (key) {
    case 'all':
      return '';
    case 'running':
      return 'queued,running';
    case 'published':
      return 'succeeded';
    case 'failed':
      return 'failed';
    case 'cancelled':
      return 'cancelled';
  }
}

function itemMatchesFilter(item: HistoryItem, key: HistoryFilter): boolean {
  if (key === 'all') return true;
  if (key === 'running') return item.status === 'queued' || item.status === 'running';
  if (key === 'published') return item.publishedResearchId !== null;
  if (key === 'failed') return item.status === 'failed';
  if (key === 'cancelled') return item.status === 'cancelled';
  return true;
}

function relativeTime(iso: string | null): string {
  if (!iso) return '—';
  const ms = Date.now() - new Date(iso).getTime();
  if (Number.isNaN(ms) || ms < 0) return '—';
  const sec = Math.floor(ms / 1000);
  if (sec < 60) return `${sec} 秒前`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min} 分钟前`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr} 小时前`;
  const day = Math.floor(hr / 24);
  if (day < 7) return `${day} 天前`;
  const wk = Math.floor(day / 7);
  if (wk < 5) return `${wk} 周前`;
  return `${Math.floor(day / 30)} 个月前`;
}

/** 状态图标 —— 替代原来的 emoji（✅ ⚠️ ⏳）。 */
function StatusIcon({ status, published }: { status: string; published: boolean }) {
  if (published || status === 'succeeded') {
    return <CheckCircle2 className="size-4 shrink-0 text-status-succeeded-fg" />;
  }
  if (status === 'failed' || status === 'cancelled') {
    return <AlertTriangle className="size-4 shrink-0 text-status-failed-fg" />;
  }
  if (status === 'partial') {
    return <AlertTriangle className="size-4 shrink-0 text-status-partial-fg" />;
  }
  return <Loader2 className="size-4 shrink-0 animate-spin text-status-running-fg" />;
}

/** 历史行的补充徽章：已发布 / 失败 / 已取消 / 部分成功。无则不渲染。 */
function historyBadgeValue(item: HistoryItem): string | null {
  if (item.publishedResearchId) return 'published';
  if (item.status === 'failed') return 'failed';
  if (item.status === 'cancelled') return 'cancelled';
  if (item.status === 'partial') return 'partial';
  return null;
}

// 表单底部的"已指定资料"提示 —— 当前模式从上方单选框读出,这里只补一个计数。
function StatusRow({ sourcePolicy: _sourcePolicy, sources }: { sourcePolicy: 'prefer_user_sources' | 'only_user_sources'; sources: { value: string }[] }) {
  const filled = sources.filter((source) => source.value.trim()).length;
  if (filled === 0) return null;
  return (
    <SectionCard tone="muted" icon={Info} title="参考资料" bodyClassName="py-3">
      <p className="text-xs text-muted-foreground">
        已指定 <span className="font-mono tabular-nums text-foreground">{filled}</span> / 10 条资料。
      </p>
    </SectionCard>
  );
}

function AiResearchHistory() {
  const [filter, setFilter] = useState<HistoryFilter>('all');
  const [rerunning, setRerunning] = useState<string | null>(null);
  const [rerunError, setRerunError] = useState<string | null>(null);
  const router = useRouter();
  // 当用户从其他页(例如 /ai-research/[jobId])通过 #research-history 锚链接
  // 跳到这里时,给标题加视觉高亮与 aria-current,告知"你正在查看历史区"。
  const [highlighted, setHighlighted] = useState(false);

  const q = useQuery<{ items: HistoryItem[]; total: number }>({
    queryKey: ['ai-research-jobs', filter],
    queryFn: async () => {
      const params = new URLSearchParams();
      const status = filterToQuery(filter);
      if (status) params.set('status', status);
      params.set('limit', '50');
      const r = await fetch(`/api/ai-research/jobs?${params.toString()}`, { cache: 'no-store' });
      if (!r.ok) throw await toApiHttpError(r, '加载历史失败');
      return (await r.json()) as { items: HistoryItem[]; total: number };
    },
    retry: retryOnceAi,
    refetchInterval: (data) => {
      // 进行中状态下每 8s 拉一次；终态停下来以免噪音
      const items = data?.state.data?.items ?? [];
      const hasInFlight = items.some((it) => it.status === 'queued' || it.status === 'running');
      return hasInFlight ? 8_000 : false;
    },
  });

  const allItems = q.data?.items ?? [];
  const filteredItems = allItems.filter((it) => itemMatchesFilter(it, filter));

  const tabCounts: Record<HistoryFilter, number> = {
    all: allItems.length,
    running: allItems.filter((it) => it.status === 'queued' || it.status === 'running').length,
    published: allItems.filter((it) => it.publishedResearchId !== null).length,
    failed: allItems.filter((it) => it.status === 'failed').length,
    cancelled: allItems.filter((it) => it.status === 'cancelled').length,
  };

  // 高亮锚点 #research-history:hash 变化时点亮标题,3 秒后自动熄灭,
  // 既给屏幕阅读器一个明确的当前位置信号,又不长期残留视觉噪音。
  useEffect(() => {
    function check() {
      if (typeof window === 'undefined') return;
      setHighlighted(window.location.hash === '#research-history');
    }
    check();
    window.addEventListener('hashchange', check);
    let timer: ReturnType<typeof setTimeout> | undefined;
    if (window.location.hash === '#research-history') {
      timer = setTimeout(() => setHighlighted(false), 3000);
    }
    return () => {
      window.removeEventListener('hashchange', check);
      if (timer) clearTimeout(timer);
    };
  }, []);

  async function rerun(item: HistoryItem) {
    // v0 重跑：POST 一条同样的 topic（不带 sourceRefs，避免被截断）。
    // idempotencyKey 必须不同——用户视角是"新发起一次"。
    setRerunning(item.jobId);
    setRerunError(null);
    try {
      const r = await fetch('/api/ai-research', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          topic: item.topic,
          reportType: item.reportType,
          sourcePolicy: item.sourcePolicy,
          sourceRefs: [],
          idempotencyKey: crypto.randomUUID(),
        }),
      });
      if (!r.ok) {
        const err = (await r.json().catch(() => ({ message: '重跑失败' }))) as { message?: string };
        const msg = err instanceof Error ? friendlyMessage(err, `重跑失败（${r.statusText ?? '网络异常'}）`) : `重跑失败：${r.statusText ?? '网络异常'}`;
        setRerunError(msg);
        return;
      }
      const data = (await r.json()) as { jobId: string };
      writeLastSubmitted(data.jobId, item.topic);
      q.refetch(); // 立刻把新行刷到表格
      router.push(`/ai-research/${data.jobId}`);
    } finally {
      setRerunning(null);
    }
  }

  return (
    <div id="research-history" className="mt-8 scroll-mt-20 space-y-3">
      <LastSubmittedBanner />

      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2
          aria-current={highlighted ? 'location' : undefined}
          className={cn(
            'flex items-center gap-1.5 rounded-md px-2 py-1 text-sm font-semibold transition-colors',
            highlighted && 'bg-primary/10 text-primary ring-1 ring-primary/30',
          )}
        >
          <FolderOpen className="size-4" />
          调研历史
          {highlighted ? (
            <span className="sr-only">(当前位置)</span>
          ) : null}
        </h2>
        <div className="flex flex-wrap gap-1">
          {FILTERS.map((f) => (
            <Button
              key={f.key}
              type="button"
              variant={filter === f.key ? 'default' : 'outline'}
              size="xs"
              className="rounded-full"
              onClick={() => setFilter(f.key)}
            >
              {f.label}
              <span className="tabular-nums opacity-75">{tabCounts[f.key]}</span>
            </Button>
          ))}
        </div>
      </div>

      {rerunError ? (
        <div role="alert" className="rounded-md border border-destructive/40 bg-destructive/10 p-2.5 text-sm text-destructive">
          {rerunError}
        </div>
      ) : null}

      <div className="overflow-hidden rounded-md border border-border bg-card">
        {q.isLoading ? (
          <Table>
            <TableHeader>
              <TableRow className="hover:bg-transparent">
                <TableHead>主题</TableHead>
                <TableHead className="w-40">进度</TableHead>
                <TableHead className="w-28">创建时间</TableHead>
                <TableHead className="w-32 text-right">操作</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody aria-live="polite" aria-busy={q.isFetching}>
              {[0, 1, 2, 3, 4].map((i) => (
                <TableRow key={i} className="hover:bg-transparent">
                  <TableCell>
                    <div className="flex items-center gap-2">
                      <Skeleton className="size-4 rounded-full" />
                      <Skeleton className="h-4 w-3/4" />
                    </div>
                  </TableCell>
                  <TableCell>
                    <Skeleton className="h-3 w-24" />
                  </TableCell>
                  <TableCell>
                    <Skeleton className="h-3 w-16" />
                  </TableCell>
                  <TableCell className="text-right">
                    <Skeleton className="ml-auto h-3 w-16" />
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        ) : q.isError ? (
          <EmptyState
            title="加载历史失败"
            description={friendlyMessage(q.error, '请稍后重试')}
            action={
              <Button type="button" size="sm" onClick={() => void q.refetch()}>
                重试
              </Button>
            }
          />
        ) : filteredItems.length === 0 ? (
          <EmptyState
            title={tabCounts.all === 0 ? '还没有调研任务' : '当前过滤下没有任务'}
            description={
              tabCounts.all === 0
                ? '提交上方表单后，任务会出现在这里。'
                : '换个过滤条件看看其他任务。'
            }
          />
        ) : (
          <Table>
            <TableHeader>
              <TableRow className="hover:bg-transparent">
                <TableHead>主题</TableHead>
                <TableHead className="w-40">进度</TableHead>
                <TableHead className="w-28">创建时间</TableHead>
                <TableHead className="w-32 text-right">操作</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody aria-live="polite" aria-busy={q.isFetching}>
              {filteredItems.map((item) => {
                const badgeValue = historyBadgeValue(item);
                const isInFlight = item.status === 'queued' || item.status === 'running';
                const itemPct = progressPct({
                  status: item.status,
                  finalStatus: item.finalStatus ?? null,
                  currentStep: item.currentStep,
                });
                return (
                  <TableRow
                    key={item.jobId}
                    className="cursor-pointer focus-within:bg-muted/30"
                    onClick={(e) => {
                      // 排除点击 button 的冒泡(打开/重新运行按钮自身处理)
                      const target = e.target as HTMLElement;
                      if (target.closest('button, a')) return;
                      router.push(`/ai-research/${item.jobId}`);
                    }}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' && !(e.target as HTMLElement).closest('button, a')) {
                        e.preventDefault();
                        router.push(`/ai-research/${item.jobId}`);
                      }
                    }}
                  >
                    <TableCell>
                      <div className="flex items-center gap-2">
                        <StatusIcon
                          status={item.status}
                          published={item.publishedResearchId !== null}
                        />
                        <span className="font-medium">{item.topic}</span>
                        {badgeValue ? <StatusBadge kind="job" value={badgeValue} /> : null}
                        <span className="text-[11px] text-muted-foreground">
                          {REPORT_TYPE_LABEL[item.reportType] ?? '调研任务'}
                        </span>
                      </div>
                    </TableCell>
                    <TableCell>
                      <div className="flex flex-col gap-1">
                        {item.currentStep ? (
                          <span className="font-mono text-xs text-muted-foreground">
                            {STEP_LABEL[item.currentStep] ?? item.currentStep}
                          </span>
                        ) : (
                          <span className="text-xs text-muted-foreground/60">—</span>
                        )}
                        <div className="flex items-center gap-2">
                          <Progress value={itemPct} className="h-1 w-20" />
                          <span className="font-mono text-[11px] tabular-nums text-muted-foreground">
                            {itemPct}%
                          </span>
                        </div>
                      </div>
                    </TableCell>
                    <TableCell className="whitespace-nowrap text-muted-foreground">
                      {relativeTime(item.createdAt)}
                    </TableCell>
                    <TableCell className="text-right" onClick={(e) => e.stopPropagation()}>
                      <Button asChild variant="link" size="xs">
                        <Link href={`/ai-research/${item.jobId}`}>打开</Link>
                      </Button>
                      <Button
                        type="button"
                        variant="link"
                        size="xs"
                        className={cn(isInFlight && 'text-muted-foreground')}
                        disabled={isInFlight || rerunning === item.jobId}
                        onClick={() => void rerun(item)}
                      >
                        {rerunning === item.jobId ? '重新运行中…' : '重新运行'}
                      </Button>
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        )}
      </div>
    </div>
  );
}

// 把 AiResearchHistory 挂到对话工作区下面。

function AiResearchPageClient() {
  const searchParams = useSearchParams();
  const conversationId = searchParams.get('conversation');
  return (
    <div className="mx-auto max-w-shell">
      <PageHeader
        title="AI 调研"
        description="把一个需要判断的问题交给 AI，对话会保存为可继续的研究会话。"
      />
      <div className="grid items-start gap-6 lg:grid-cols-[280px_minmax(0,1fr)]">
        <AiResearchConversationSidebar activeConversationId={conversationId} />
        <div className="min-w-0">
          <AiResearchConversation conversationId={conversationId} />
        </div>
      </div>
      <AiResearchHistory />
    </div>
  );
}

export default function AiResearchPage() {
  return (
    <Suspense
      fallback={
        <div className="mx-auto max-w-shell space-y-2">
          <Skeleton className="h-8 w-40" />
          <Skeleton className="h-32 w-full max-w-2xl" />
        </div>
      }
    >
      <AiResearchPageClient />
    </Suspense>
  );
}
