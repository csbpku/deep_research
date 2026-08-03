'use client';

// /ai-research —— 提交表单 + 调研历史。
//
// ⚠️ e2e 契约：
//   - form 上的 data-ai-research-form 属性
//   - aria-label="资料类型" / "资料地址或 ID"
//   - 提交按钮文案含「提交」；正文含 /AI 调研/
//   - LastSubmittedBanner 的 aria-label="关闭"

import { useRouter, useSearchParams } from 'next/navigation';
import Link from 'next/link';
import { useQuery } from '@tanstack/react-query';
import { Suspense, useEffect, useState } from 'react';

import { useMediaQuery } from '@/lib/hooks/use-media-query';
import {
  AlertTriangle,
  CheckCircle2,
  ChevronRight,
  FolderOpen,
  Loader2,
  Plus,
  Rocket,
  Send,
  X,
} from 'lucide-react';

import { EmptyState } from '@/components/EmptyState';
import { PageHeader } from '@/components/domain/PageHeader';
import { StatusBadge } from '@/components/domain/StatusBadge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Skeleton } from '@/components/ui/skeleton';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { cn } from '@/lib/utils';
import { friendlyMessage } from '@/lib/errors/friendly';
import { toApiHttpError } from '@/lib/errors/api-error';
import { retryOnceAi } from '@/lib/errors/friendly';

interface ApiError {
  code: string;
  message: string;
  requestId?: string;
}

interface RadarSeed {
  id: string;
  title: string;
  url: string;
  interpretation: string | null;
  body: string | null;
}

interface SourceRefInput {
  id: string;
  type: 'url' | 'summary' | 'research';
  value: string;
  required: boolean;
}

const REPORT_TYPES: Array<{ value: 'research_report' | 'summary_brief'; label: string; desc: string }> = [
  {
    value: 'research_report',
    label: '长文调研',
    desc: '5 步流水线（规划 → 检索 → 压缩 → 分析 → 写作），生成可编辑的私有草稿。',
  },
  {
    value: 'summary_brief',
    label: '轻量摘要',
    desc: '抓取 + 压缩 + 写作的轻量路径，不写草稿，结果返回到本页。',
  },
];

/** 表单里的分组框 —— 与 SectionCard 观感一致，但语义上是 fieldset。 */
function FormSection({
  legend,
  hint,
  children,
  defaultOpen = true,
}: {
  legend: string;
  hint?: string;
  children: React.ReactNode;
  /** 移动端默认是否折叠。桌面下默认始终展开。 */
  defaultOpen?: boolean;
}) {
  // 移动端（< md）默认折叠，减少首屏信息量；桌面保持展开。
  const isDesktop = useMediaQuery('(min-width: 768px)');
  const [open, setOpen] = useState(isDesktop || defaultOpen);
  // 切到桌面时强制展开；切回移动端时跟随 defaultOpen。
  useEffect(() => {
    if (isDesktop) setOpen(true);
    else setOpen(defaultOpen);
  }, [isDesktop, defaultOpen]);

  return (
    <details
      open={open}
      onToggle={(e) => setOpen((e.target as HTMLDetailsElement).open)}
      className="rounded-lg border border-border bg-card p-3 [&_summary::-webkit-details-marker]:hidden"
    >
      <summary className="-mx-1 flex cursor-pointer list-none items-center justify-between gap-2 rounded px-1 py-0.5 text-xs font-medium uppercase tracking-wide text-muted-foreground transition-colors hover:bg-muted/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
        <span className="inline-flex items-center gap-1.5">
          <ChevronRight className={cn('size-3.5 transition-transform duration-200', open && 'rotate-90')} aria-hidden />
          {legend}
        </span>
        <span className="text-[10px] font-normal normal-case tracking-normal text-muted-foreground/70">
          {open ? '收起' : '展开'}
        </span>
      </summary>
      {hint ? <p className="mb-2 mt-2 text-xs text-muted-foreground">{hint}</p> : null}
      <div className="mt-2">{children}</div>
    </details>
  );
}

function AiResearchForm() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const seedId = searchParams.get('seed');
  const [topic, setTopic] = useState('');
  const [context, setContext] = useState('');
  const [reportType, setReportType] = useState<'research_report' | 'summary_brief'>('research_report');
  const [submitting, setSubmitting] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [seedWarning, setSeedWarning] = useState<string | null>(null);
  const [seededSummaryId, setSeededSummaryId] = useState<string | null>(null);
  const [sourcePolicy, setSourcePolicy] = useState<'prefer_user_sources' | 'only_user_sources'>('prefer_user_sources');
  const [sources, setSources] = useState<SourceRefInput[]>([]);

  useEffect(() => {
    if (!seedId) return;

    let cancelled = false;
    setSeedWarning(null);
    void fetch(`/api/radar/${encodeURIComponent(seedId)}`, { cache: 'no-store' })
      .then(async (response) => {
        if (!response.ok) throw new Error('种子雷达候选不可读');
        return await response.json() as RadarSeed;
      })
      .then((seed) => {
        if (cancelled) return;
        const seedContext = [
          seed.interpretation ?? '',
          `来源: ${seed.url}`,
          '',
          (seed.body ?? '').slice(0, 800),
        ].filter(Boolean).join('\n');
        setTopic(seed.title.slice(0, 200));
        setContext(seedContext.slice(0, 2000));
        setSeededSummaryId(seed.id);
        setSources((current) => current.some((source) => source.type === 'summary' && source.value === seed.id)
          ? current
          : [...current, { id: crypto.randomUUID(), type: 'summary', value: seed.id, required: true }]);
      })
      .catch((seedError: unknown) => {
        if (!cancelled) {
          setSeedWarning(seedError instanceof Error
            ? `预填失败：${seedError.message}，可手动输入`
            : '预填失败，可手动输入');
        }
      });

    return () => {
      cancelled = true;
    };
  }, [seedId]);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setErr(null);
    if (topic.trim().length < 2) {
      setErr('主题至少 2 个字');
      return;
    }
    if (sourcePolicy === 'only_user_sources' && !sources.some((source) => source.value.trim())) {
      setErr('only 模式至少需要一条指定资料');
      return;
    }
    setSubmitting(true);
    try {
      const sourceRefs = sources
        .filter((source) => source.value.trim())
        .map((source) => ({ type: source.type, value: source.value.trim(), required: source.required }));
      const r = await fetch('/api/ai-research', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          topic: topic.trim(),
          context: context.trim() || undefined,
          reportType,
          sourcePolicy,
          sourceRefs,
          idempotencyKey: crypto.randomUUID(),
        }),
      });
      if (!r.ok) {
        const body = (await r.json().catch(() => ({ message: '提交失败' }))) as ApiError;
        setErr(`${body.code}: ${body.message}`);
        return;
      }
      const body = (await r.json()) as { jobId: string };
      // 跳详情；前端从 /ai-research/[jobId] 拿状态
      // 顺手把刚提交的写入 sessionStorage，详情页按"返回"后，
      // 历史区域的上方能看到"查看刚提交的"横幅（120s TTL）。
      try {
        if (typeof window !== 'undefined') {
          window.sessionStorage.setItem(
            LAST_SUBMITTED_KEY,
            JSON.stringify({ jobId: body.jobId, topic: topic.trim(), at: Date.now() }),
          );
        }
      } catch {
        // sessionStorage 在隐身/受限模式下不可用 —— 横幅不显示，但提交本身成功。
      }
      router.push(`/ai-research/${body.jobId}`);
    } catch (e2) {
      setErr(String((e2 as Error).message ?? '提交失败'));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div>
      <PageHeader
        title="AI 调研"
        description="输入主题与团队背景；提交后自动跟踪调研进度。"
      />

      {seedWarning ? (
        <div
          role="alert"
          className="mb-3 rounded-md bg-status-partial-bg px-3 py-2 text-sm text-status-partial-fg"
        >
          {seedWarning}
        </div>
      ) : null}

      <form data-ai-research-form onSubmit={onSubmit} className="grid max-w-2xl gap-3">
        <div className="grid gap-1.5">
          <label htmlFor="ai-topic" className="text-sm font-medium">
            主题 <span className="text-destructive">*</span>
          </label>
          <Input
            id="ai-topic"
            type="text"
            value={topic}
            onChange={(e) => setTopic(e.target.value)}
            placeholder="例如：RAG 在企业知识库的落地挑战"
            maxLength={200}
            required
          />
        </div>

        <div className="grid gap-1.5">
          <label htmlFor="ai-context" className="text-sm font-medium">
            团队背景 / 上下文（可选）
          </label>
          <Textarea
            id="ai-context"
            value={context}
            onChange={(e) => setContext(e.target.value)}
            placeholder="例如：我们是 30 人后端团队，目前用 PostgreSQL + pgvector，正在评估混合检索…"
            maxLength={2000}
            rows={4}
          />
        </div>

        <FormSection
          legend="指定资料（最多 10 条）"
          hint="可粘贴外部 URL、雷达候选 ID 或已发布调研的 ID。"
        >
          <div className="grid gap-2">
            {sources.map((source) => {
              const isSeeded = source.type === 'summary' && source.value === seededSummaryId;
              return (
                <div
                  key={source.id}
                  className="grid grid-cols-1 items-center gap-2 sm:grid-cols-[130px_1fr_auto_auto]"
                >
                  {/* 原生 select：e2e 用 aria-label="资料类型" 定位并 selectOption，
                      换成 Radix Select 会破坏该契约，这里保持原生但套 token 样式。 */}
                  <select
                    aria-label="资料类型"
                    value={source.type}
                    disabled={isSeeded}
                    onChange={(e) => setSources((current) => current.map((item) => item.id === source.id ? { ...item, type: e.target.value as SourceRefInput['type'], value: '' } : item))}
                    className="h-9 cursor-pointer rounded-md border border-input bg-card px-2 text-sm shadow-sm disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    <option value="url">指定 URL</option>
                    <option value="summary">雷达候选</option>
                    <option value="research">调研库</option>
                  </select>
                  <Input
                    aria-label="资料地址或 ID"
                    type="text"
                    value={source.value}
                    readOnly={isSeeded}
                    placeholder={source.type === 'url' ? 'https://example.com/article' : 'ID'}
                    onChange={(e) => setSources((current) => current.map((item) => item.id === source.id ? { ...item, value: e.target.value } : item))}
                  />
                  <label className="flex cursor-pointer items-center gap-1.5 whitespace-nowrap text-xs text-muted-foreground">
                    <input
                      type="checkbox"
                      className="cursor-pointer accent-primary"
                      checked={source.required}
                      onChange={(e) => setSources((current) => current.map((item) => item.id === source.id ? { ...item, required: e.target.checked } : item))}
                    />
                    必须使用
                  </label>
                  <Button
                    type="button"
                    variant="ghost"
                    size="xs"
                    className="text-destructive hover:text-destructive"
                    onClick={() => setSources((current) => current.filter((item) => item.id !== source.id))}
                  >
                    移除
                  </Button>
                </div>
              );
            })}
          </div>
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="mt-2"
            disabled={sources.length >= 10}
            onClick={() => setSources((current) => [...current, { id: crypto.randomUUID(), type: 'url', value: '', required: false }])}
          >
            <Plus />
            添加资料
          </Button>
        </FormSection>

        <FormSection legend="资料优先级">
          <div className="space-y-1.5">
            <label className="flex cursor-pointer items-center gap-2 text-sm">
              <input
                type="radio"
                name="sourcePolicy"
                className="cursor-pointer accent-primary"
                checked={sourcePolicy === 'prefer_user_sources'}
                onChange={() => setSourcePolicy('prefer_user_sources')}
              />
              优先使用指定资料，可补充外部搜索（prefer）
            </label>
            <label className="flex cursor-pointer items-center gap-2 text-sm">
              <input
                type="radio"
                name="sourcePolicy"
                className="cursor-pointer accent-primary"
                checked={sourcePolicy === 'only_user_sources'}
                onChange={() => setSourcePolicy('only_user_sources')}
              />
              仅使用指定资料（only）
            </label>
          </div>
        </FormSection>

        <FormSection legend="报告类型">
          <div className="space-y-2">
            {REPORT_TYPES.map((rt) => (
              <label key={rt.value} className="flex cursor-pointer items-start gap-2">
                <input
                  type="radio"
                  name="reportType"
                  value={rt.value}
                  className="mt-1 cursor-pointer accent-primary"
                  checked={reportType === rt.value}
                  onChange={() => setReportType(rt.value)}
                />
                <span className="text-sm">
                  <strong className="font-medium">{rt.label}</strong>
                  <span className="block text-muted-foreground">{rt.desc}</span>
                </span>
              </label>
            ))}
          </div>
        </FormSection>

        <StatusRow sourcePolicy={sourcePolicy} sources={sources} />

        {err ? (
          <div role="alert" className="text-sm text-destructive">
            {err}
          </div>
        ) : null}

        <div className="sticky bottom-0 -mx-4 mt-2 flex justify-end gap-2 border-t border-border bg-background/90 px-4 py-3 backdrop-blur supports-[backdrop-filter]:bg-background/70 sm:static sm:mx-0 sm:mt-0 sm:border-0 sm:bg-transparent sm:p-0 sm:backdrop-blur-none">
          <Button type="submit" disabled={submitting}>
            {submitting ? <Loader2 className="animate-spin" /> : <Send />}
            {submitting ? '提交中…' : '提交调研'}
          </Button>
        </div>
      </form>
    </div>
  );
}

// ─── 调研历史（独立 client component，避免污染表单的 Suspense + useSearchParams） ───

interface HistoryItem {
  jobId: string;
  topic: string;
  status: string;
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
  { key: 'running', label: '跑中' },
  { key: 'published', label: '已发布' },
  { key: 'failed', label: '失败' },
  { key: 'cancelled', label: '已取消' },
];

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

// 表单底部的「当前模式」提示：把 API enum (prefer_user_sources / only_user_sources)
// 翻译成中文标签，避免在 UI 上泄漏内部命名。
const SOURCE_POLICY_LABEL: Record<'prefer_user_sources' | 'only_user_sources', string> = {
  prefer_user_sources: '优先使用指定资料，可补充外部搜索',
  only_user_sources: '仅使用指定资料',
};

function StatusRow({ sourcePolicy, sources }: { sourcePolicy: 'prefer_user_sources' | 'only_user_sources'; sources: { value: string }[] }) {
  return (
    <p className="text-xs text-muted-foreground">
      当前模式：{SOURCE_POLICY_LABEL[sourcePolicy]}；已指定{' '}
      {sources.filter((source) => source.value.trim()).length} 条资料。
    </p>
  );
}

interface LastSubmitted {
  jobId: string;
  topic: string;
  at: number;
}

const LAST_SUBMITTED_KEY = 'ai-research:last-submitted:v1';

interface LastSubmitted {
  jobId: string;
  topic: string;
  at: number;
}

function readLastSubmitted(): LastSubmitted | null {
  if (typeof window === 'undefined') return null;
  try {
    const raw = window.sessionStorage.getItem(LAST_SUBMITTED_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as LastSubmitted;
    if (typeof parsed.jobId !== 'string' || typeof parsed.at !== 'number') return null;
    if (Date.now() - parsed.at > 120_000) {
      window.sessionStorage.removeItem(LAST_SUBMITTED_KEY);
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

function LastSubmittedBanner({
  entry,
  onDismiss,
}: {
  entry: LastSubmitted;
  onDismiss: () => void;
}) {
  return (
    <div
      role="status"
      className="flex flex-wrap items-center gap-3 rounded-lg border border-primary/30 bg-accent/50 px-3.5 py-2.5 text-sm text-accent-foreground"
    >
      <Rocket className="size-4 shrink-0" />
      <span className="flex-1">
        刚提交的：<strong className="font-medium">{entry.topic}</strong>
      </span>
      <Button asChild size="xs">
        <Link href={`/ai-research/${entry.jobId}`}>查看进度</Link>
      </Button>
      <Button type="button" variant="ghost" size="icon-sm" onClick={onDismiss} aria-label="关闭">
        <X />
      </Button>
    </div>
  );
}

export function AiResearchHistory() {
  const [filter, setFilter] = useState<HistoryFilter>('all');
  const [lastSubmitted, setLastSubmitted] = useState<LastSubmitted | null>(null);
  const [rerunning, setRerunning] = useState<string | null>(null);
  const [rerunError, setRerunError] = useState<string | null>(null);

  useEffect(() => {
    setLastSubmitted(readLastSubmitted());
  }, []);

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
      try {
        window.sessionStorage.setItem(
          LAST_SUBMITTED_KEY,
          JSON.stringify({ jobId: data.jobId, topic: item.topic, at: Date.now() }),
        );
      } catch {}
      q.refetch(); // 立刻把新行刷到表格
      window.location.href = `/ai-research/${data.jobId}`;
    } finally {
      setRerunning(null);
    }
  }

  return (
    <div className="mt-8 space-y-3">
      {lastSubmitted ? (
        <LastSubmittedBanner
          entry={lastSubmitted}
          onDismiss={() => {
            window.sessionStorage.removeItem(LAST_SUBMITTED_KEY);
            setLastSubmitted(null);
          }}
        />
      ) : null}

      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="flex items-center gap-1.5 text-sm font-semibold">
          <FolderOpen className="size-4 text-muted-foreground" />
          调研历史
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

      <div className="overflow-hidden rounded-lg border border-border bg-card">
        {q.isLoading ? (
          <div className="space-y-2 p-4">
            {[0, 1, 2].map((i) => (
              <Skeleton key={i} className="h-8 w-full" />
            ))}
          </div>
        ) : q.isError ? (
          <div className="grid gap-1.5 p-6 text-center">
            <p className="text-sm font-medium text-destructive">{friendlyMessage(q.error, '加载历史失败')}</p>
            {q.error instanceof Error ? null : null}
            <p className="text-xs text-muted-foreground">已自动重试一次，可刷新再试。</p>
          </div>
        ) : filteredItems.length === 0 ? (
          <p className="p-6 text-center text-sm text-muted-foreground">
            暂无{tabCounts.all === 0 ? '调研任务。提交上面表单后会出现在这里。' : '当前过滤下的任务。'}
          </p>
        ) : (
          <Table>
            <TableHeader>
              <TableRow className="hover:bg-transparent">
                <TableHead>主题</TableHead>
                <TableHead className="w-40">状态</TableHead>
                <TableHead className="w-20">成本</TableHead>
                <TableHead className="w-28">创建时间</TableHead>
                <TableHead className="w-32 text-right">操作</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {filteredItems.map((item) => {
                const badgeValue = historyBadgeValue(item);
                const isInFlight = item.status === 'queued' || item.status === 'running';
                return (
                  <TableRow
                    key={item.jobId}
                    className="cursor-pointer"
                    onClick={() => {
                      window.location.href = `/ai-research/${item.jobId}`;
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
                      </div>
                    </TableCell>
                    <TableCell className="text-sm text-muted-foreground">
                      {/* 不再显示原始 status 枚举 —— StatusIcon + StatusBadge 已传达语义 */}
                      {item.currentStep ? (
                        <span className="font-mono text-xs">
                          · {item.currentStep}
                        </span>
                      ) : (
                        <span className="text-xs text-muted-foreground/60">—</span>
                      )}
                    </TableCell>
                    <TableCell className="tabular-nums text-muted-foreground">
                      ${(item.costCents / 100).toFixed(2)}
                    </TableCell>
                    <TableCell className="whitespace-nowrap text-muted-foreground">
                      {relativeTime(item.createdAt)}
                    </TableCell>
                    <TableCell className="text-right" onClick={(e) => e.stopPropagation()}>
                      <Button asChild variant="link" size="xs">
                        <Link href={`/ai-research/${item.jobId}`}>查看</Link>
                      </Button>
                      <Button
                        type="button"
                        variant="link"
                        size="xs"
                        className={cn(isInFlight && 'text-muted-foreground')}
                        disabled={isInFlight || rerunning === item.jobId}
                        onClick={() => void rerun(item)}
                      >
                        {rerunning === item.jobId ? '重跑中…' : '重跑'}
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

// 把 AiResearchHistory 挂到 form 下面 —— outer 也是 client 组件。
// AiResearchForm 仍然自己管 useSearchParams/Suspense，AiResearchHistory
// 不依赖 searchParams，二者互不污染。

function AiResearchPageClient() {
  return (
    <div className="mx-auto max-w-shell">
      <AiResearchForm />
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
