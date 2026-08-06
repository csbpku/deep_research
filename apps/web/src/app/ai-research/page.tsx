'use client';

// /ai-research —— 提交表单 + 调研历史。
//
// ⚠️ e2e 契约：
//   - form 上的 data-ai-research-form 属性
//   - aria-label="资料类型"；URL 输入保留 aria-label="资料地址或 ID"
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
  Info,
  Loader2,
  Plus,
  Search,
  Send,
} from 'lucide-react';

import { EmptyState } from '@/components/EmptyState';
import { PageHeader } from '@/components/domain/PageHeader';
import { SectionCard } from '@/components/domain/SectionCard';
import { StatusBadge } from '@/components/domain/StatusBadge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
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
  label?: string;
}

interface SourceOption {
  id: string;
  title: string;
  meta?: string;
}

const REPORT_TYPES: Array<{ value: 'research_report' | 'summary_brief'; label: string; desc: string }> = [
  {
    value: 'research_report',
    label: '研究报告',
    desc: '走完整流水线 + 事实审核，生成可编辑的私有草稿。',
  },
  {
    value: 'summary_brief',
    label: '轻量摘要',
    desc: '抓取 + 压缩 + 写作的轻量路径，结果直接返回本页。',
  },
];

/** 仅用于 React 列表 key，不进入 API；避免旧浏览器缺少 crypto.randomUUID 时点击失效。 */
function createSourceRowId(): string {
  return `source-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

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
      className="rounded-md border border-border bg-card p-3 [&_summary::-webkit-details-marker]:hidden"
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

function InternalSourcePicker({
  kind,
  value,
  label,
  disabled,
  onChange,
}: {
  kind: 'summary' | 'research';
  value: string;
  label?: string;
  disabled?: boolean;
  onChange: (option: SourceOption | null) => void;
}) {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<SourceOption[]>([]);
  const [loading, setLoading] = useState(false);
  const [searchError, setSearchError] = useState<string | null>(null);
  const [editing, setEditing] = useState(!value);

  useEffect(() => {
    setQuery('');
    setEditing(!value);
  }, [kind]);

  useEffect(() => {
    if (disabled || (value && !editing)) return;

    const controller = new AbortController();
    const timer = window.setTimeout(() => {
      setLoading(true);
      setSearchError(null);
      const params = new URLSearchParams();
      const trimmedQuery = query.trim();
      if (trimmedQuery) params.set('q', trimmedQuery);

      const endpoint = kind === 'summary'
        ? `/api/radar?per_page=8&${params}`
        : `/api/researches?scope=published&limit=8&${params}`;

      void fetch(endpoint, { cache: 'no-store', signal: controller.signal })
        .then(async (response) => {
          if (!response.ok) throw new Error('资料搜索失败');
          const data = await response.json() as {
            items?: Array<{
              id: string;
              title: string;
              sourceType?: string;
              status?: string;
              publishedAt?: string | null;
              author?: { name?: string };
            }>;
          };
          return (data.items ?? []).map((item) => ({
            id: item.id,
            title: item.title,
            meta: kind === 'summary'
              ? item.sourceType ?? item.status
              : [item.author?.name, item.publishedAt?.slice(0, 10)].filter(Boolean).join(' · '),
          }));
        })
        .then(setResults)
        .catch((error: unknown) => {
          if ((error as Error).name !== 'AbortError') {
            setResults([]);
            setSearchError('没有加载到资料，请稍后重试。');
          }
        })
        .finally(() => setLoading(false));
    }, 250);

    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [disabled, editing, kind, query, value]);

  if (value && !editing) {
    return (
      <div className="flex min-w-0 items-center gap-2 rounded-md border border-primary/25 bg-primary/5 px-3 py-2">
        <CheckCircle2 className="size-4 shrink-0 text-primary" aria-hidden />
        <span className="min-w-0 flex-1 truncate text-sm font-medium" title={label}>
          {label ?? '已选资料'}
        </span>
        {!disabled ? (
          <>
            <Button type="button" variant="ghost" size="xs" onClick={() => setEditing(true)}>
              更换
            </Button>
            <Button type="button" variant="ghost" size="xs" onClick={() => onChange(null)}>
              清除
            </Button>
          </>
        ) : null}
      </div>
    );
  }

  return (
    <div className="min-w-0 rounded-md border border-input bg-card shadow-sm">
      <div className="flex items-center gap-2 px-3">
        <Search className="size-4 shrink-0 text-muted-foreground" aria-hidden />
        <input
          type="search"
          aria-label={kind === 'summary' ? '搜索雷达内容' : '搜索已发布调研'}
          value={query}
          autoFocus={editing && Boolean(value)}
          onChange={(event) => setQuery(event.target.value)}
          placeholder={kind === 'summary' ? '搜索标题、标签或关键词' : '搜索调研标题或正文'}
          className="h-9 min-w-0 flex-1 bg-transparent text-sm outline-none placeholder:text-muted-foreground"
        />
        {loading ? <Loader2 className="size-4 animate-spin text-muted-foreground" aria-label="正在搜索" /> : null}
      </div>
      <div className="max-h-52 overflow-y-auto border-t border-border p-1">
        {searchError ? (
          <p role="status" className="px-2 py-3 text-xs text-status-partial-fg">{searchError}</p>
        ) : results.length === 0 && !loading ? (
          <p className="px-2 py-3 text-xs text-muted-foreground">
            {query.trim() ? '没有匹配结果，换个关键词试试。' : '暂无可选资料。'}
          </p>
        ) : (
          results.map((option) => (
            <button
              key={option.id}
              type="button"
              onClick={() => {
                onChange(option);
                setEditing(false);
              }}
              className="group flex w-full items-center gap-3 rounded px-2 py-2 text-left transition-colors hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm font-medium">{option.title}</span>
                {option.meta ? (
                  <span className="block truncate text-[11px] text-muted-foreground">{option.meta}</span>
                ) : null}
              </span>
              <span className="shrink-0 text-xs font-medium text-primary opacity-0 transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100">
                选择
              </span>
            </button>
          ))
        )}
      </div>
    </div>
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
    let cancelled = false;
    void fetch('/api/me/preferences', { cache: 'no-store' })
      .then(async (response) => {
        if (!response.ok) return null;
        return await response.json() as {
          preferences?: {
            defaultReportType?: 'research_report' | 'summary_brief';
            defaultSourcePolicy?: 'prefer_user_sources' | 'only_user_sources' | 'web_only';
          };
        };
      })
      .then((data) => {
        if (cancelled || !data?.preferences) return;
        if (data.preferences.defaultReportType) {
          setReportType(data.preferences.defaultReportType);
        }
        if (
          data.preferences.defaultSourcePolicy === 'prefer_user_sources'
          || data.preferences.defaultSourcePolicy === 'only_user_sources'
        ) {
          setSourcePolicy(data.preferences.defaultSourcePolicy);
        }
      })
      .catch(() => {
        // 偏好加载失败不阻断主流程，继续使用表单默认值。
      });
    return () => {
      cancelled = true;
    };
  }, []);

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
          : [...current, {
              id: createSourceRowId(),
              type: 'summary',
              value: seed.id,
              required: true,
              label: seed.title,
            }]);
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
      setErr('选择“只使用所选资料”时，至少需要添加一条参考资料。');
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
        setErr(friendlyMessage(await toApiHttpError(r, '提交失败'), '提交失败，请稍后重试。'));
        return;
      }
      const body = (await r.json()) as { jobId: string };
      // 跳详情；顺手把刚提交的写入 sessionStorage，详情页按"返回"或
      // 首页直接访问时都能看到"查看刚提交的"横幅（120s TTL）。
      writeLastSubmitted(body.jobId, topic.trim());
      router.push(`/ai-research/${body.jobId}`);
    } catch (e2) {
      setErr(String((e2 as Error).message ?? '提交失败'));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div>
      {seedWarning ? (
        <div
          role="alert"
          className="mb-3 rounded-md bg-status-partial-bg px-3 py-2 text-sm text-status-partial-fg"
        >
          {seedWarning}
        </div>
      ) : null}

      <form data-ai-research-form onSubmit={onSubmit} className="grid max-w-2xl gap-3 lg:h-full">
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
          legend="参考资料（可选，最多 10 条）"
          hint="粘贴外部 URL，或按标题从雷达和调研库中选择；平台会自动处理内部 ID。"
        >
          <div className="grid gap-2">
            {sources.map((source) => {
              const isSeeded = source.type === 'summary' && source.value === seededSummaryId;
              return (
                <div
                  key={source.id}
                  className="grid grid-cols-1 items-start gap-2 sm:grid-cols-[130px_minmax(0,1fr)_auto_auto]"
                >
                  {/* 原生 select：e2e 用 aria-label="资料类型" 定位并 selectOption，
                      换成 Radix Select 会破坏该契约，这里保持原生但套 token 样式。 */}
                  <select
                    aria-label="资料类型"
                    value={source.type}
                    disabled={isSeeded}
                    onChange={(e) => setSources((current) => current.map((item) => item.id === source.id ? {
                      ...item,
                      type: e.target.value as SourceRefInput['type'],
                      value: '',
                      label: undefined,
                    } : item))}
                    className="h-9 cursor-pointer rounded-md border border-input bg-card px-2 text-sm shadow-sm disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    <option value="url">网页链接</option>
                    <option value="summary">雷达内容</option>
                    <option value="research">已发布调研</option>
                  </select>
                  {source.type === 'url' ? (
                    <Input
                      aria-label="资料地址或 ID"
                      type="url"
                      value={source.value}
                      placeholder="https://example.com/article"
                      onChange={(e) => setSources((current) => current.map((item) => item.id === source.id ? { ...item, value: e.target.value } : item))}
                    />
                  ) : (
                    <InternalSourcePicker
                      kind={source.type}
                      value={source.value}
                      disabled={isSeeded}
                      label={source.label}
                      onChange={(selected) => {
                        setSources((current) => current.map((item) => item.id === source.id ? {
                          ...item,
                          value: selected?.id ?? '',
                          label: selected?.title,
                        } : item));
                      }}
                    />
                  )}
                  <label className="flex h-9 cursor-pointer items-center gap-1.5 whitespace-nowrap text-xs text-muted-foreground">
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
                    className="mt-1 text-destructive hover:text-destructive"
                    onClick={() => setSources((current) => current.filter((item) => item.id !== source.id))}
                  >
                    移除
                  </Button>
                </div>
              );
            })}
          </div>
          <div className="mt-2 flex items-center gap-3">
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={sources.length >= 10}
              onClick={() => setSources((current) => [...current, {
                id: createSourceRowId(),
                type: 'url',
                value: '',
                required: false,
              }])}
            >
              <Plus />
              添加参考资料
            </Button>
            <span aria-live="polite" className="text-xs text-muted-foreground">
              {sources.length > 0 ? `已添加 ${sources.length}/10` : '尚未添加'}
            </span>
          </div>
        </FormSection>

        <FormSection legend="资料使用方式" defaultOpen={false}>
          <div className="grid gap-2 sm:grid-cols-2">
            <label className={cn(
              'flex cursor-pointer flex-col gap-1 rounded-md border p-3 text-xs transition-colors',
              sourcePolicy === 'prefer_user_sources'
                ? 'border-primary bg-accent/60 text-accent-foreground'
                : 'border-border bg-card text-muted-foreground hover:border-primary/30'
            )}>
              <span className="flex items-center gap-2">
                <input
                  type="radio"
                  name="sourcePolicy"
                  className="cursor-pointer accent-primary"
                  checked={sourcePolicy === 'prefer_user_sources'}
                  onChange={() => setSourcePolicy('prefer_user_sources')}
                />
                优先参考所选资料
              </span>
              <span className="pl-6 text-muted-foreground">必要时搜索互联网补充</span>
            </label>
            <label className={cn(
              'flex cursor-pointer flex-col gap-1 rounded-md border p-3 text-xs transition-colors',
              sourcePolicy === 'only_user_sources'
                ? 'border-primary bg-accent/60 text-accent-foreground'
                : 'border-border bg-card text-muted-foreground hover:border-primary/30'
            )}>
              <span className="flex items-center gap-2">
                <input
                  type="radio"
                  name="sourcePolicy"
                  className="cursor-pointer accent-primary"
                  checked={sourcePolicy === 'only_user_sources'}
                  onChange={() => setSourcePolicy('only_user_sources')}
                />
                只使用所选资料
              </span>
              <span className="pl-6 text-muted-foreground">不搜索互联网</span>
            </label>
          </div>
        </FormSection>

        <FormSection legend="报告类型" defaultOpen={false}>
          <div className="grid gap-2 sm:grid-cols-2">
            {REPORT_TYPES.map((rt) => (
              <label
                key={rt.value}
                className={cn(
                  'flex cursor-pointer flex-col gap-1 rounded-md border p-3 text-xs transition-colors',
                  reportType === rt.value
                    ? 'border-primary bg-accent/60 text-accent-foreground'
                    : 'border-border bg-card text-muted-foreground hover:border-primary/30'
                )}
              >
                <span className="flex items-center gap-2">
                  <input
                    type="radio"
                    name="reportType"
                    value={rt.value}
                    className="cursor-pointer accent-primary"
                    checked={reportType === rt.value}
                    onChange={() => setReportType(rt.value)}
                  />
                  <strong className="font-medium">{rt.label}</strong>
                </span>
                <span className="pl-6 text-muted-foreground">{rt.desc}</span>
              </label>
            ))}
          </div>
        </FormSection>

        <StatusRow sourcePolicy={sourcePolicy} sources={sources} />

        {err ? (
          <div
            role="alert"
            className="flex flex-wrap items-center gap-2 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive"
          >
            <AlertTriangle className="size-3.5 shrink-0" />
            <span className="flex-1">{err}</span>
            <Button
              type="button"
              variant="outline"
              size="xs"
              onClick={() => {
                setErr(null);
                void onSubmit({ preventDefault: () => {} } as React.FormEvent);
              }}
            >
              重试
            </Button>
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
};

const STEP_LABEL: Record<string, string> = {
  plan: '规划',
  search: '检索资料',
  compress: '整理证据',
  analyze: '分析',
  write: '撰写报告',
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
      writeLastSubmitted(data.jobId, item.topic);
      q.refetch(); // 立刻把新行刷到表格
      window.location.href = `/ai-research/${data.jobId}`;
    } finally {
      setRerunning(null);
    }
  }

  return (
    <div id="research-history" className="mt-8 scroll-mt-20 space-y-3">
      <LastSubmittedBanner />

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
            <TableBody>
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
            <TableBody>
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

// 把 AiResearchHistory 挂到 form 下面 —— outer 也是 client 组件。
// AiResearchForm 仍然自己管 useSearchParams/Suspense，AiResearchHistory
// 不依赖 searchParams，二者互不污染。

function AiResearchPageClient() {
  return (
    <div className="mx-auto max-w-shell">
      <PageHeader
        title="AI 调研"
        description="输入主题与团队背景，提交后跟踪进度。"
      />
      <div className="grid gap-4 lg:grid-cols-[minmax(0,1.1fr)_minmax(300px,.9fr)] lg:items-stretch">
        <div className="lg:h-full">
          <AiResearchForm />
        </div>
        <ResearchPipelineRail />
      </div>
      <AiResearchHistory />
    </div>
  );
}

function ResearchPipelineRail() {
  const steps = [
    ['1', '规划研究问题', '拆分背景、约束和验证方向', '提交后开始'],
    ['2', '检索与抓取', '优先处理指定资料，再补充外部来源', '待开始'],
    ['3', '压缩证据', '合并相似结论并保留来源链路', '待开始'],
    ['4', '分析与对比', '形成可执行的取舍和风险判断', '待开始'],
    ['5', '写作草稿', '生成可编辑的团队私有草稿', '待开始'],
    ['6', '事实审核', '核验高风险事实、引用和来源冲突', '待开始'],
  ];
  return (
    <aside className="flex h-full flex-col rounded-md border border-border bg-card p-5 lg:sticky lg:top-20">
      <h2 className="text-base font-semibold">调研流程预览</h2>
      <ol className="mt-5 flex-1 space-y-1">
        {steps.map(([number, title, description, state], index) => (
          <li key={number} className="relative flex gap-3 py-3">
            {index < steps.length - 1 ? <span className="absolute left-[11px] top-9 h-8 w-px bg-border" aria-hidden /> : null}
            <span className="z-10 grid size-6 shrink-0 place-items-center rounded-full bg-muted font-mono text-[11px] text-muted-foreground">{number}</span>
            <span className="min-w-0">
              <strong className="block text-xs font-medium">{title}</strong>
              <span className="mt-0.5 block text-[11px] leading-5 text-muted-foreground">{description}</span>
            </span>
            <span className="ml-auto shrink-0 font-mono text-[10px] text-muted-foreground">{state}</span>
          </li>
        ))}
      </ol>
      <p className="mt-3 border-t border-border pt-3 text-xs leading-5 text-muted-foreground">
        研究报告走 6 步（含事实审核）；轻量摘要跳过审核。
      </p>
    </aside>
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
