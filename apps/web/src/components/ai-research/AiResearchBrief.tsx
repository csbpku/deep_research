// ADR 0010: Research Brief 客户端组件。
//
// 在对话主题明确后，把用户问题喂给 /api/ai-research/plan，拿到
// objective / matching topic / suggested context，渲染为一张连续的
// 研究确认面板；用户可以接受建议或修改。
//
// 研究前只让用户确认一条连续的研究方案：回答什么、参考什么资料、
// 生成什么结果。内部的检索步骤和偏好按需展开，不要求用户先理解系统流程。

'use client';

import { useEffect, useMemo, useState, type ReactNode } from 'react';
import Link from 'next/link';
import {
  BookOpenCheck,
  Loader2,
  Sparkles,
  Tag,
} from 'lucide-react';

import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';
import { friendlyMessage } from '@/lib/errors/friendly';
import type { ResearchScope, ResearchTimeRange } from '@deep-research/shared/schemas';

type Objective = 'explore' | 'learn' | 'investigate' | 'decide';
type ContextSourceRef = {
  type: 'url' | 'favorite' | 'research' | 'summary';
  value: string;
  required: boolean;
};

const OBJECTIVE_LABELS: Record<Objective, string> = {
  explore: '快速概览',
  learn: '系统学习',
  investigate: '深入调研',
  decide: '决策对比',
};

interface PlanResponse {
  assistantMessage: string;
  brief: {
    objective: Objective;
    question: string;
    constraints?: string[];
    questionsToAnswer?: string[];
    comparisonOptions?: string[];
    successCriteria?: string[];
    contextRefs?: ContextSourceRef[];
    primaryTopicId?: string;
    outputType: 'markdown' | 'slides' | 'web';
    sourcePolicy: 'prefer_user_sources' | 'only_user_sources';
    scope: ResearchScope;
  };
  plan?: { summary: string; steps?: Array<{ title: string; detail?: string }>; estimatedMinutes: number };
  ready: boolean;
  missingFields: string[];
  suggestedTopics: Array<{ topicId: string; slug: string; name: string; confidence: number }>;
  suggestedContext: Array<PersonalContextItem>;
}

interface PersonalContextItem {
  kind: 'research' | 'knowledge' | 'issue' | 'bookmark';
  id: string;
  title: string;
  snippet: string;
  private?: boolean;
  sourceRefs?: ContextSourceRef[];
}

interface BriefProps {
  question: string;
  context: string;
  topicHint?: string;
  children?: ReactNode;
  startAction?: ReactNode;
  onBriefReady?: (brief: BriefValue) => void;
  onPlanningChange?: (planning: boolean) => void;
}

export interface BriefValue {
  objective: Objective;
  primaryTopicId?: string;
  suggestedContextIds: string[];
  assistantMessage: string;
  scopeValid?: boolean;
  brief?: {
    objective: Objective;
    question: string;
    constraints: string[];
    questionsToAnswer: string[];
    comparisonOptions: string[];
    successCriteria: string[];
    sourcePolicy: 'prefer_user_sources' | 'only_user_sources';
    scope: ResearchScope;
    primaryTopicId?: string;
    outputType: 'markdown' | 'slides' | 'web';
    contextRefs: ContextSourceRef[];
  };
}

interface FetchState {
  status: 'idle' | 'loading' | 'ready' | 'error';
  plan?: PlanResponse;
  error?: string;
  authRequired?: boolean;
}

const IGNORE_PREFIX = '上下文暂忽略：';
export function AiResearchBrief({ question, context, topicHint, children, startAction, onBriefReady, onPlanningChange }: BriefProps) {
  const trimmed = question.trim();
  const isShort = trimmed.length < 8;
  const [state, setState] = useState<FetchState>({ status: 'idle' });
  const [acceptedContextIds, setAcceptedContextIds] = useState<string[]>([]);
  const [focusText, setFocusText] = useState('');
  const [comparisonText, setComparisonText] = useState('');
  const [objective, setObjective] = useState<Objective>('investigate');
  const [timeRange, setTimeRange] = useState<ResearchTimeRange['preset']>('any');
  const [scopeFrom, setScopeFrom] = useState('');
  const [scopeTo, setScopeTo] = useState('');
  const [retrievalNotes, setRetrievalNotes] = useState('');
  const [contextSearch, setContextSearch] = useState('');
  const [contextSearchItems, setContextSearchItems] = useState<PersonalContextItem[]>([]);
  const [contextSearchLoading, setContextSearchLoading] = useState(false);

  useEffect(() => {
    const query = contextSearch.trim();
    if (query.length < 2) {
      setContextSearchItems([]);
      setContextSearchLoading(false);
      return;
    }
    let cancelled = false;
    setContextSearchLoading(true);
    const timer = setTimeout(() => {
      void fetch(`/api/ai-research/context?q=${encodeURIComponent(query)}`, { cache: 'no-store' })
        .then(async (response) => {
          if (!response.ok) throw new Error(`context search failed: ${response.status}`);
          return await response.json() as { items?: Array<PersonalContextItem & { kind?: string }> };
        })
        .then((data) => {
          if (cancelled) return;
          setContextSearchItems((data.items ?? []).filter((item): item is PersonalContextItem => (
            (item.kind === 'research' || item.kind === 'knowledge' || item.kind === 'issue' || item.kind === 'bookmark') &&
            typeof item.id === 'string' && typeof item.title === 'string' &&
            (item.sourceRefs === undefined || item.sourceRefs.every((ref) => (
              (ref.type === 'research' || ref.type === 'summary') &&
              typeof ref.value === 'string' && ref.required === false
            )))
          )));
        })
        .catch(() => {
          if (!cancelled) setContextSearchItems([]);
        })
        .finally(() => {
          if (!cancelled) setContextSearchLoading(false);
        });
    }, 280);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [contextSearch]);

  useEffect(() => {
    if (isShort) {
      setState({ status: 'idle' });
      return;
    }
    let cancelled = false;
    setState({ status: 'loading' });
    onPlanningChange?.(true);
    void fetch('/api/ai-research/plan', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ question: trimmed, ...(context.trim() ? { constraints: [context.trim()] } : {}) }),
    })
      .then(async (response) => {
        if (!response.ok) {
          setState({
            status: 'error',
            error: friendlyMessage(
              { message: `规划请求返回 ${response.status}` } as Error,
              response.status === 401 ? '登录后才能匹配历史专题和已保存研究。' : '规划请求失败，稍后重试。',
            ),
            authRequired: response.status === 401,
          });
          onPlanningChange?.(false);
          return;
        }
        const data = (await response.json()) as PlanResponse;
        if (cancelled) return;
        setState({ status: 'ready', plan: data });
        setFocusText((data.brief.questionsToAnswer ?? []).join('\n'));
        setComparisonText((data.brief.comparisonOptions ?? []).join('\n'));
        setObjective(data.brief.objective);
        setTimeRange(data.brief.scope?.timeRange?.preset ?? 'any');
        setScopeFrom(data.brief.scope?.timeRange?.from ?? '');
        setScopeTo(data.brief.scope?.timeRange?.to ?? '');
        // 地区 / 技术版本是旧 schema 的兼容字段，不再把它们转换成
        // 新 UI 的自然语言提示，避免让用户误以为所有研究都需要这类
        // 并不普适的过滤条件。
        setRetrievalNotes(data.brief.scope?.retrievalNotes ?? '');
        onPlanningChange?.(false);
        setAcceptedContextIds([]);
        onBriefReady?.({
          objective: data.brief.objective,
          primaryTopicId: data.brief.primaryTopicId ?? topicHint,
          suggestedContextIds: [],
          assistantMessage: data.assistantMessage,
          scopeValid: true,
          brief: {
            objective: data.brief.objective,
            question: data.brief.question,
            constraints: data.brief.constraints ?? [],
            questionsToAnswer: data.brief.questionsToAnswer ?? [],
            comparisonOptions: data.brief.comparisonOptions ?? [],
            successCriteria: data.brief.successCriteria ?? [],
            sourcePolicy: data.brief.sourcePolicy ?? 'prefer_user_sources',
            scope: data.brief.scope ?? emptyScope(),
            primaryTopicId: data.brief.primaryTopicId ?? topicHint,
            outputType: data.brief.outputType ?? 'markdown',
            contextRefs: [],
          },
        });
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setState({
          status: 'error',
          error: friendlyMessage(err, '规划请求失败，稍后重试。'),
        });
        onPlanningChange?.(false);
      });
    return () => { cancelled = true; onPlanningChange?.(false); };
  // 重新规划应当由用户主动触发，不在 context 变化时触发
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [trimmed]);

  const availableContext = useMemo(() => {
    const merged = new Map<string, PersonalContextItem>();
    for (const item of [...(state.plan?.suggestedContext ?? []), ...contextSearchItems]) {
      merged.set(`${item.kind}:${item.id}`, item);
    }
    return Array.from(merged.values());
  }, [contextSearchItems, state.plan]);

  if (isShort) {
    return (
      <div className={cn('rounded-lg border border-dashed border-border bg-card/60 p-3 text-xs text-muted-foreground')}>
        <Sparkles className="mr-1 inline size-3.5" />
        待主题明确后会显示推荐的研究目标和上下文。
      </div>
    );
  }

  if (state.status === 'loading') {
    return (
      <PlanningFallback
        loading
        question={trimmed}
        startAction={startAction}
      >
        {children}
      </PlanningFallback>
    );
  }

  if (state.status === 'error') {
    return (
      <PlanningFallback
        question={trimmed}
        error={state.error ?? '规划请求失败'}
        authRequired={state.authRequired}
        startAction={startAction}
      >
        {children}
      </PlanningFallback>
    );
  }

  const plan = state.plan;
  if (!plan) return null;
  const resolvedPlan = plan;

  function publishPlan({
    nextObjective = objective,
    nextFocusText = focusText,
    nextComparisonText = comparisonText,
    nextTimeRange = timeRange,
    nextScopeFrom = scopeFrom,
    nextScopeTo = scopeTo,
    nextRetrievalNotes = retrievalNotes,
    selectedIds = acceptedContextIds,
  }: {
    nextObjective?: Objective;
    nextFocusText?: string;
    nextComparisonText?: string;
    nextTimeRange?: ResearchTimeRange['preset'];
    nextScopeFrom?: string;
    nextScopeTo?: string;
    nextRetrievalNotes?: string;
    selectedIds?: string[];
  } = {}) {
    const ids: string[] = [];
    if (state.plan) {
      for (const item of availableContext) {
        if (selectedIds.includes(item.id)) {
          ids.push(item.id);
        }
      }
    }
    const questionsToAnswer = nextFocusText
      .split(/\n|；|;/u)
      .map((item) => item.trim())
      .filter(Boolean)
      .slice(0, 20);
    const comparisonOptions = nextComparisonText
      .split(/\n|；|;|、/u)
      .map((item) => item.trim())
      .filter(Boolean)
      .slice(0, 20);
    const validScope = nextTimeRange !== 'custom'
      || (!!nextScopeFrom && !!nextScopeTo && nextScopeFrom <= nextScopeTo);
    onBriefReady?.({
      objective: nextObjective,
      primaryTopicId: plan!.brief.primaryTopicId ?? topicHint,
      suggestedContextIds: ids,
      assistantMessage: plan!.assistantMessage,
      scopeValid: validScope,
      brief: {
        objective: nextObjective,
        question: plan!.brief.question,
        constraints: plan!.brief.constraints ?? [],
        questionsToAnswer,
        comparisonOptions,
        successCriteria: plan!.brief.successCriteria ?? [],
        sourcePolicy: plan!.brief.sourcePolicy ?? 'prefer_user_sources',
        scope: {
          timeRange: {
            preset: nextTimeRange,
            ...(nextTimeRange === 'custom' && nextScopeFrom ? { from: nextScopeFrom } : {}),
            ...(nextTimeRange === 'custom' && nextScopeTo ? { to: nextScopeTo } : {}),
          },
          // 旧 brief 里的结构化字段继续保留；新 UI 用自然语言承载
          // 只有在确实相关时才需要填写的地区/版本等限定。
          regions: plan!.brief.scope?.regions ?? [],
          technologyVersions: plan!.brief.scope?.technologyVersions ?? [],
          retrievalNotes: nextRetrievalNotes.trim().slice(0, 400),
        },
        primaryTopicId: plan!.brief.primaryTopicId ?? topicHint,
        outputType: plan!.brief.outputType ?? 'markdown',
        contextRefs: idsToContextRefs(ids, plan!.brief.contextRefs ?? [], availableContext),
      },
    });
  }

  function toggleContext(id: string) {
    const set = new Set(acceptedContextIds);
    if (set.has(id)) set.delete(id);
    else set.add(id);
    const next = Array.from(set);
    setAcceptedContextIds(next);
    publishPlan({ selectedIds: next });
  }

  const currentQuestions = splitPlanItems(focusText);
  const currentComparisons = splitPlanItems(comparisonText, true);
  const missingFields = plan.missingFields.filter((field) => (
    (field !== 'questionsToAnswer' || currentQuestions.length === 0)
    && (field !== 'comparisonOptions' || currentComparisons.length === 0)
  ));
  if (objective === 'decide' && currentComparisons.length === 0 && !missingFields.includes('comparisonOptions')) {
    missingFields.push('comparisonOptions');
  }
  const objectiveChanged = objective !== plan.brief.objective;
  const scopeIncomplete = timeRange === 'custom'
    && (!scopeFrom || !scopeTo || scopeFrom > scopeTo);
  const hasSearchPreferences = timeRange !== 'any' || !!retrievalNotes.trim();
  const planStatusText = missingFields.length > 0
    ? `还可以补充：${missingFields.map((field) => translateMissing(field)).join('、')}；也可以直接开始。`
    : '研究方案已准备好，可以直接开始。';

  return (
    <div className="overflow-hidden rounded-md border border-primary/25 bg-card text-xs">
      <header className="flex items-start justify-between gap-3 border-b border-border/70 px-4 py-3">
        <div>
          <span className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-primary">
            <BookOpenCheck className="size-3.5" /> 研究方案
          </span>
          <p className="mt-1 text-[11px] leading-5 text-muted-foreground">确认要回答什么、参考哪些资料和需要什么产出；启动后设置会锁定。</p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <Badge variant="secondary" className="text-[10px]">
            {OBJECTIVE_LABELS[objective]}
          </Badge>
          {startAction}
        </div>
      </header>

      <section className="space-y-3 px-4 py-4" aria-label="研究方案">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h3 className="font-medium text-foreground">回答什么</h3>
          <span className="text-[10px] text-muted-foreground">AI 已根据问题整理，可调整</span>
        </div>

        <fieldset className="space-y-1.5">
        <legend className="font-medium text-foreground">研究目标</legend>
        <div className="flex flex-wrap gap-1.5">
          {(Object.keys(OBJECTIVE_LABELS) as Objective[]).map((value) => (
            <button
              key={value}
              type="button"
              aria-pressed={objective === value}
              onClick={() => {
                setObjective(value);
                publishPlan({ nextObjective: value });
              }}
              className={cn(
                'rounded-full border px-2.5 py-1 text-[11px] transition-colors',
                objective === value
                  ? 'border-primary bg-primary/10 font-medium text-primary'
                  : 'border-border bg-background text-muted-foreground hover:border-primary/40 hover:text-foreground',
              )}
            >
              {OBJECTIVE_LABELS[value]}
            </button>
          ))}
        </div>
        </fieldset>

      <p className="text-[12px] leading-5 text-muted-foreground">
        {objectiveChanged
          ? `已调整为「${OBJECTIVE_LABELS[objective]}」；提交时以当前目标、重点问题和对比对象为准。`
          : planStatusText}
      </p>

      {resolvedPlan.plan || resolvedPlan.brief.successCriteria?.length ? (
        <details className="rounded-md border border-border/70 bg-muted/35">
          <summary className="flex cursor-pointer list-none items-center justify-between gap-2 px-2.5 py-2 font-medium text-foreground [&::-webkit-details-marker]:hidden">
            <span>AI 会怎样完成这次研究？</span>
            <span className="text-[10px] font-normal text-muted-foreground">研究路径与完成标准</span>
          </summary>
          <div className="space-y-2 border-t border-border/70 px-2.5 py-2.5">
            {resolvedPlan.plan ? (
              <div>
                <p className="font-medium text-foreground">
                  {objectiveChanged
                    ? objective === 'decide' && currentComparisons.length > 0
                      ? `对比 ${currentComparisons.join('、')}，并形成有证据支撑的优先级建议。`
                      : `按「${OBJECTIVE_LABELS[objective]}」目标组织证据并生成结论。`
                    : resolvedPlan.plan.summary}
                </p>
                <p className="mt-0.5 text-[11px] text-muted-foreground">
                  预计需要几分钟到十几分钟；可以离开页面，完成后再回来查看。
                </p>
                {resolvedPlan.plan.steps?.length ? (
                  <ul className="mt-2 flex flex-wrap gap-x-3 gap-y-1 border-t border-border/70 pt-2 text-muted-foreground">
                    {resolvedPlan.plan.steps.slice(0, 4).map((step) => <li key={step.title}><span aria-hidden="true">·</span>{' '}{step.title}</li>)}
                  </ul>
                ) : null}
              </div>
            ) : null}
            {resolvedPlan.brief.successCriteria?.length ? (
              <div className="border-t border-border/70 pt-2">
                <p className="font-medium text-foreground">完成标准</p>
                <ul className="mt-1 space-y-1 text-[11px] leading-4 text-muted-foreground">
                  {resolvedPlan.brief.successCriteria.slice(0, 4).map((criterion) => (
                    <li key={criterion} className="flex gap-1.5">
                      <span className="text-primary" aria-hidden="true">✓</span>
                      <span>{criterion}</span>
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}
          </div>
        </details>
      ) : null}

      <div className={cn('grid gap-3', objective === 'decide' && 'md:grid-cols-2')}>
        <label className="block space-y-1.5">
          <span className="font-medium text-foreground">重点回答</span>
          <textarea
            value={focusText}
            onChange={(event) => {
              const next = event.target.value;
              setFocusText(next);
              publishPlan({ nextFocusText: next });
            }}
            rows={2}
            placeholder="例如：上线成本\n团队维护复杂度\n适合什么时候采用"
            className="w-full resize-y rounded-md border border-input bg-background px-2.5 py-2 text-xs leading-5 outline-none focus:border-primary focus:ring-2 focus:ring-primary/20"
              aria-label="研究重点回答"
          />
        </label>

        {objective === 'decide' ? (
          <label className="block space-y-1.5">
              <span className="font-medium text-foreground">对比对象</span>
            <textarea
              value={comparisonText}
              onChange={(event) => {
                const next = event.target.value;
                setComparisonText(next);
                publishPlan({ nextComparisonText: next });
              }}
              rows={2}
              placeholder="例如：Claude Research\nGemini Deep Research\nChatGPT Deep Research"
              className="w-full resize-y rounded-md border border-input bg-background px-2.5 py-2 text-xs leading-5 outline-none focus:border-primary focus:ring-2 focus:ring-primary/20"
              aria-label="研究对比对象"
            />
          </label>
        ) : null}
      </div>

      {children ? (
        <div className="border-t border-border/70 pt-4" aria-label="资料与产出">
          {children}
        </div>
      ) : null}
      </section>

      <section className="border-t border-border/70 px-4 py-3" aria-label="更多设置">
        <div className="mb-2">
          <h3 className="font-medium text-foreground">更多设置</h3>
          <p className="mt-0.5 text-[11px] leading-5 text-muted-foreground">默认由 AI 安排；只有有明确偏好时再调整。</p>
        </div>
        <div className="space-y-2" aria-label="更多检索设置">
      <details className="rounded-md border border-border/70 bg-background/60">
        <summary className="flex cursor-pointer list-none items-center justify-between gap-2 px-2.5 py-2 font-medium text-foreground">
          <span>检索偏好（可选）</span>
          <span className="text-[10px] font-normal text-muted-foreground">{hasSearchPreferences ? '已设置' : '只在需要时展开'}</span>
        </summary>
        <div className="space-y-2 border-t border-border/70 px-2.5 py-2.5">
          <p className="text-[11px] leading-5 text-muted-foreground">告诉 AI 先看什么、重点关注什么；不填写表示由 AI 自行安排。</p>
          <fieldset className="space-y-1">
            <legend className="font-medium text-foreground">优先参考时间</legend>
            <div className="flex flex-wrap gap-1.5">
              {TIME_RANGE_OPTIONS.map((option) => (
                <button
                  key={option.value}
                  type="button"
                  aria-pressed={timeRange === option.value}
                  onClick={() => {
                    setTimeRange(option.value);
                    publishPlan({ nextTimeRange: option.value });
                  }}
                  className={cn(
                    'rounded-full border px-2.5 py-1 text-[11px] transition-colors',
                    timeRange === option.value
                      ? 'border-primary bg-primary/10 font-medium text-primary'
                      : 'border-border bg-background text-muted-foreground hover:border-primary/40 hover:text-foreground',
                  )}
                >
                  {option.label}
                </button>
              ))}
            </div>
          </fieldset>
          {timeRange === 'custom' ? (
            <div className="grid gap-2 sm:grid-cols-2">
              <label className="space-y-1">
            <span className="text-[11px] text-muted-foreground">起始日期</span>
                <input
                  type="date"
                  value={scopeFrom}
                  max={scopeTo || undefined}
                  aria-invalid={scopeIncomplete && (!scopeFrom || scopeFrom > scopeTo) ? true : undefined}
                  onChange={(event) => {
                    const next = event.target.value;
                    setScopeFrom(next);
                    publishPlan({ nextScopeFrom: next });
                  }}
                  className="w-full rounded-md border border-input bg-background px-2 py-1.5 text-xs outline-none focus:border-primary focus:ring-2 focus:ring-primary/20"
                  aria-label="优先参考起始日期"
                />
              </label>
              <label className="space-y-1">
                <span className="text-[11px] text-muted-foreground">结束日期</span>
                <input
                  type="date"
                  value={scopeTo}
                  min={scopeFrom || undefined}
                  aria-invalid={scopeIncomplete && (!scopeTo || scopeFrom > scopeTo) ? true : undefined}
                  onChange={(event) => {
                    const next = event.target.value;
                    setScopeTo(next);
                    publishPlan({ nextScopeTo: next });
                  }}
                  className="w-full rounded-md border border-input bg-background px-2 py-1.5 text-xs outline-none focus:border-primary focus:ring-2 focus:ring-primary/20"
                  aria-label="优先参考结束日期"
                />
              </label>
            </div>
          ) : null}
          <label className="block space-y-1">
            <span className="text-[11px] text-muted-foreground">关注点或偏好</span>
            <textarea
              value={retrievalNotes}
              onChange={(event) => {
                const next = event.target.value;
                setRetrievalNotes(next);
                publishPlan({ nextRetrievalNotes: next });
              }}
              rows={2}
              maxLength={400}
              placeholder="例如：优先官方文档；关注迁移和兼容性"
              aria-label="检索关注点或偏好"
              className="w-full resize-y rounded-md border border-input bg-background px-2.5 py-1.5 text-xs leading-5 outline-none focus:border-primary focus:ring-2 focus:ring-primary/20"
            />
          </label>
          {scopeIncomplete ? (
            <p role="alert" className="rounded-md border border-warning-border/50 bg-warning-bg/40 px-2 py-1.5 text-[11px] leading-5 text-warning-fg">
              请同时填写开始和结束日期；结束日期不能早于开始日期。补全后才能启动研究。
            </p>
          ) : null}
          <p className="text-[10px] leading-4 text-muted-foreground">时间只影响检索优先级；网页可能没有可靠的发布日期。</p>
        </div>
      </details>

      <details className="rounded-md border border-border/70 bg-background/60">
        <summary className="flex cursor-pointer list-none items-center justify-between gap-2 px-2.5 py-2 font-medium text-foreground">
          <span className="flex items-center gap-1.5"><Tag className="size-3" />已有资料（可选）</span>
          <span className="text-[10px] font-normal text-muted-foreground">历史研究、知识库、收藏、专题议题</span>
        </summary>
        <div className="space-y-2 border-t border-border/70 px-2.5 py-2.5">
          <p className="text-[11px] leading-5 text-muted-foreground">只会把你选中的资料带入本次研究；不选择也可以直接搜索网页。</p>
          <div className="flex flex-wrap gap-1.5">
            {availableContext.slice(0, 8).map((item) => {
              const accepted = acceptedContextIds.includes(item.id);
              return (
                <button
                  type="button"
                  key={`${item.kind}-${item.id}`}
                  onClick={() => toggleContext(item.id)}
                  aria-pressed={accepted}
                  className={cn(
                    'inline-flex max-w-full items-center gap-1.5 rounded-full border px-2.5 py-1 text-left text-[11px] transition-colors',
                    accepted
                      ? 'border-primary bg-primary/8 text-foreground'
                      : 'border-border bg-card text-muted-foreground hover:border-primary/40 hover:text-foreground',
                  )}
                  title={item.snippet}
                >
                  <span className="max-w-[160px] truncate font-medium">{item.title}</span>
                  <span className="rounded-full bg-muted px-1.5 text-[10px] tracking-wide text-muted-foreground">{contextKindLabel(item.kind)}</span>
                  {item.private ? <span className="text-[10px] text-primary">仅本人</span> : null}
                </button>
              );
            })}
          </div>
          <label className="block space-y-1">
          <span className="text-[11px] text-muted-foreground">搜索可用资料（历史研究、知识库、收藏与专题议题）</span>
            <input
              value={contextSearch}
              onChange={(event) => setContextSearch(event.target.value)}
              placeholder="按标题或正文关键词搜索"
              aria-label="搜索个人资料"
              className="w-full rounded-md border border-input bg-background px-2.5 py-1.5 text-xs outline-none focus:border-primary focus:ring-2 focus:ring-primary/20"
            />
          </label>
          {contextSearchLoading ? <p className="text-[11px] text-muted-foreground">正在搜索可用个人资料…</p> : null}
          <p className="text-[10px] leading-4 text-muted-foreground">只显示你有权限使用的资料；选中后会随本次研究保存为来源。</p>
        </div>
      </details>
        </div>
      </section>

      {missingFields.length > 0 ? (
        <p className="border-t border-warning-border/40 bg-warning-bg/40 px-4 py-2 text-[11px] text-warning-fg">
          建议补充：{missingFields.map((field) => translateMissing(field)).join('、')}
        </p>
      ) : null}
    </div>
  );
}

function PlanningFallback({
  question,
  loading = false,
  error,
  authRequired = false,
  startAction,
  children,
}: {
  question: string;
  loading?: boolean;
  error?: string;
  authRequired?: boolean;
  startAction?: ReactNode;
  children?: ReactNode;
}) {
  return (
    <div className="overflow-hidden rounded-md border border-primary/25 bg-card text-xs">
      <header className="flex items-start justify-between gap-3 border-b border-border/70 px-4 py-3">
        <div>
          <span className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-primary">
            <BookOpenCheck className="size-3.5" /> 研究方案
          </span>
          <p className="mt-1 max-w-xl text-[11px] leading-5 text-muted-foreground">
            {loading ? '研究方案正在生成；你可以先调整资料和产出，也可以直接开始。' : '研究方案暂时不可用；你仍可以按当前问题直接开始，完成后再补充方案。'}
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <Badge variant="secondary" className="text-[10px]">{loading ? '计划生成中' : '可直接开始'}</Badge>
          {startAction}
        </div>
      </header>
      <section className="space-y-3 px-4 py-4" aria-label="研究方案">
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <h3 className="font-medium text-foreground">回答什么</h3>
            <span className="text-[10px] text-muted-foreground">{loading ? '正在整理研究角度' : '当前问题仍可执行'}</span>
          </div>
          {loading ? (
            <div className="flex items-center gap-2 rounded-md border border-border bg-muted/40 px-3 py-3 text-[11px] text-muted-foreground" role="status">
              <Loader2 className="size-3.5 animate-spin" />
              正在为「{question.slice(0, 32)}{question.length > 32 ? '…' : ''}」整理研究角度和已有资料…
            </div>
          ) : (
            <div role="alert" className="rounded-md border border-warning-border/50 bg-warning-bg/40 px-3 py-2 text-[11px] leading-5 text-warning-fg">
              <p>{error}</p>
              <div className="mt-1 flex flex-wrap items-center gap-2">
                <span>计划不影响启动；你可以先按当前问题研究。</span>
                {authRequired ? (
                  <Link href="/signin?callbackUrl=%2Fai-research" className="font-medium underline underline-offset-2">登录后重试</Link>
                ) : null}
              </div>
            </div>
          )}
      </section>
      {children ? (
        <section className="border-t border-border/70 bg-muted/[0.12] px-4 py-4" aria-label="资料与产出">
          {children}
        </section>
      ) : null}
    </div>
  );
}

function translateMissing(field: string): string {
  if (field === 'comparisonOptions') return '对比选项';
  if (field === 'questionsToAnswer') return '研究问题';
  if (field === 'constraints') return '约束条件';
  return field;
}

const TIME_RANGE_OPTIONS: Array<{ value: ResearchTimeRange['preset']; label: string }> = [
  { value: 'any', label: '不限时间' },
  { value: '7d', label: '最近 7 天' },
  { value: '30d', label: '最近 30 天' },
  { value: '90d', label: '最近 90 天' },
  { value: '1y', label: '最近 1 年' },
  { value: 'custom', label: '自定义' },
];

function emptyScope(): ResearchScope {
  return { timeRange: { preset: 'any' }, regions: [], technologyVersions: [], retrievalNotes: '' };
}

function splitPlanItems(value: string, includeComma = false): string[] {
  const separator = includeComma ? /\n|；|;|、/u : /\n|；|;/u;
  return value.split(separator).map((item) => item.trim()).filter(Boolean).slice(0, 20);
}

function contextKindLabel(kind: 'research' | 'knowledge' | 'issue' | 'bookmark'): string {
  if (kind === 'research') return '历史研究';
  if (kind === 'knowledge') return '知识库';
  if (kind === 'bookmark') return '收藏';
  return '专题议题';
}


/** 把 acceptedContextIds + plan.brief.contextRefs 合并成可发送的 contextRefs。 */
function idsToContextRefs(
  ids: string[],
  fallback: Array<{ type: 'url' | 'favorite' | 'research' | 'summary'; value: string; required: boolean }>,
  suggested: PlanResponse['suggestedContext'],
): ContextSourceRef[] {
  if (ids.length === 0) return fallback.filter((ref) => ref.type === 'url');
  const idSet = new Set(ids);
  const refs: ContextSourceRef[] = fallback.filter((ref) => ref.type === 'url' || idSet.has(ref.value));
  for (const item of suggested) {
    if (!idSet.has(item.id)) continue;
    const itemRefs = item.sourceRefs ?? (
      item.kind === 'research' || item.kind === 'knowledge'
        ? [{ type: 'research' as const, value: item.id, required: false as const }]
        : []
    );
    for (const ref of itemRefs) {
      if (!refs.some((existing) => existing.type === ref.type && existing.value === ref.value)) {
        refs.push(ref);
      }
    }
  }
  return refs.slice(0, 10);
}
function _IGNORE_FUNCTION_REFERENCES_FOR_TSC() {
  // 帮助 tsc 接受 IGNORE_PREFIX 字段在部分构建配置下不被误读
  return IGNORE_PREFIX;
}
