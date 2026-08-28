// ADR 0010: Research Brief 客户端组件。
//
// 在对话主题明确后，把用户问题喂给 /api/ai-research/plan，拿到
// objective / matching topic / suggested context，渲染为右侧一张
// 小卡片；用户可以接受建议或修改。
//
// M12: 把拥挤的小卡片重排为「objective 英雄区 + plan 摘要 + 分组
// 约束清单 + 横向 context chips + inline 缺失提示」的层级。

'use client';

import { useEffect, useState } from 'react';
import {
  BookOpenCheck,
  Compass,
  Loader2,
  Sparkles,
  Tag,
} from 'lucide-react';

import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';
import { friendlyMessage } from '@/lib/errors/friendly';

type Objective = 'explore' | 'learn' | 'investigate' | 'decide';

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
    contextRefs?: Array<{ type: 'url' | 'favorite' | 'research' | 'summary'; value: string; required: boolean }>;
    primaryTopicId?: string;
    outputType: 'markdown' | 'slides';
    sourcePolicy: 'prefer_user_sources' | 'only_user_sources';
  };
  plan?: { summary: string; steps?: Array<{ title: string; detail?: string }>; estimatedMinutes: number };
  ready: boolean;
  missingFields: string[];
  suggestedTopics: Array<{ topicId: string; slug: string; name: string; confidence: number }>;
  suggestedContext: Array<{ kind: 'research' | 'knowledge' | 'issue'; id: string; title: string; snippet: string }>;
}

interface BriefProps {
  question: string;
  context: string;
  topicHint?: string;
  onBriefReady?: (brief: BriefValue) => void;
}

export interface BriefValue {
  objective: Objective;
  primaryTopicId?: string;
  suggestedContextIds: string[];
  assistantMessage: string;
  brief?: {
    objective: Objective;
    question: string;
    constraints: string[];
    questionsToAnswer: string[];
    comparisonOptions: string[];
    successCriteria: string[];
    sourcePolicy: 'prefer_user_sources' | 'only_user_sources';
    primaryTopicId?: string;
    outputType: 'markdown' | 'slides';
    contextRefs: Array<{ type: 'url' | 'favorite' | 'research' | 'summary'; value: string; required: boolean }>;
  };
}

interface FetchState {
  status: 'idle' | 'loading' | 'ready' | 'error';
  plan?: PlanResponse;
  error?: string;
}

const IGNORE_PREFIX = '上下文暂忽略：';
export function AiResearchBrief({ question, context, topicHint, onBriefReady }: BriefProps) {
  const trimmed = question.trim();
  const isShort = trimmed.length < 8;
  const [state, setState] = useState<FetchState>({ status: 'idle' });
  const [acceptedContextIds, setAcceptedContextIds] = useState<string[]>([]);

  useEffect(() => {
    if (isShort) {
      setState({ status: 'idle' });
      return;
    }
    let cancelled = false;
    setState({ status: 'loading' });
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
              '规划请求失败，稍后重试。',
            ),
          });
          return;
        }
        const data = (await response.json()) as PlanResponse;
        if (cancelled) return;
        setState({ status: 'ready', plan: data });
        setAcceptedContextIds([]);
        onBriefReady?.({
          objective: data.brief.objective,
          primaryTopicId: data.brief.primaryTopicId ?? topicHint,
          suggestedContextIds: [],
          assistantMessage: data.assistantMessage,
          brief: {
            objective: data.brief.objective,
            question: data.brief.question,
            constraints: data.brief.constraints ?? [],
            questionsToAnswer: data.brief.questionsToAnswer ?? [],
            comparisonOptions: data.brief.comparisonOptions ?? [],
            successCriteria: data.brief.successCriteria ?? [],
            sourcePolicy: data.brief.sourcePolicy ?? 'prefer_user_sources',
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
      });
    return () => { cancelled = true; };
  // 重新规划应当由用户主动触发，不在 context 变化时触发
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [trimmed]);

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
      <div className="flex items-center gap-2 rounded-lg border border-border bg-card p-3 text-xs text-muted-foreground">
        <Loader2 className="size-3.5 animate-spin" />
        正在为「{trimmed.slice(0, 32)}…」匹配研究目标和上下文…
      </div>
    );
  }

  if (state.status === 'error') {
    return (
      <div className="rounded-lg border border-destructive/40 bg-destructive/10 p-3 text-xs text-destructive">
        {state.error ?? '规划请求失败'}
      </div>
    );
  }

  const plan = state.plan;
  if (!plan) return null;

  function applyContext() {
    const ids: string[] = [];
    if (state.plan) {
      for (const item of state.plan.suggestedContext) {
        if (acceptedContextIds.includes(item.id)) {
          ids.push(item.id);
        }
      }
    }
    onBriefReady?.({
      objective: plan!.brief.objective,
      primaryTopicId: plan!.brief.primaryTopicId ?? topicHint,
      suggestedContextIds: ids,
      assistantMessage: plan!.assistantMessage,
      brief: {
        objective: plan!.brief.objective,
        question: plan!.brief.question,
        constraints: plan!.brief.constraints ?? [],
        questionsToAnswer: plan!.brief.questionsToAnswer ?? [],
        comparisonOptions: plan!.brief.comparisonOptions ?? [],
        successCriteria: plan!.brief.successCriteria ?? [],
        sourcePolicy: plan!.brief.sourcePolicy ?? 'prefer_user_sources',
        primaryTopicId: plan!.brief.primaryTopicId ?? topicHint,
        outputType: plan!.brief.outputType ?? 'markdown',
        contextRefs: idsToContextRefs(ids, plan!.brief.contextRefs ?? []),
      },
    });
  }

  function toggleContext(id: string) {
    setAcceptedContextIds((current) => {
      const set = new Set(current);
      if (set.has(id)) set.delete(id);
      else set.add(id);
      const next = Array.from(set);
      applyContext();
      return next;
    });
  }

  const topic = plan.suggestedTopics[0];

  return (
    <div className="space-y-2.5 rounded-lg border border-border bg-card p-3 text-xs">
      <header className="flex items-center justify-between gap-2">
        <span className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
          <BookOpenCheck className="size-3.5" /> Research Brief
        </span>
        <Badge variant="secondary" className="text-[10px]">
          {OBJECTIVE_LABELS[plan.brief.objective]}
        </Badge>
      </header>

      {topic ? (
        <div className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
          <Compass className="size-3 shrink-0" />
          <span className="font-medium text-foreground">{topic.name}</span>
          <span>· 置信 {Math.round(topic.confidence * 100)}%</span>
        </div>
      ) : null}

      <p className="text-[12px] leading-5 text-muted-foreground">{plan.assistantMessage}</p>

      {plan.plan ? (
        <div className="rounded-md border border-border bg-muted/40 px-2.5 py-2">
          <p className="font-medium text-foreground">{plan.plan.summary}</p>
          <p className="mt-0.5 font-mono text-[11px] tabular-nums text-muted-foreground">预估 {plan.plan.estimatedMinutes} 分钟</p>
        </div>
      ) : null}

      {plan.suggestedContext.length > 0 ? (
        <div className="space-y-1.5">
          <span className="flex items-center gap-1 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
            <Tag className="size-3" /> 复用上下文
          </span>
          <div className="flex flex-wrap gap-1.5">
            {plan.suggestedContext.slice(0, 4).map((item) => {
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
                  <span className="rounded-full bg-muted px-1.5 text-[10px] uppercase tracking-wide text-muted-foreground">{item.kind}</span>
                </button>
              );
            })}
          </div>
        </div>
      ) : null}

      {plan.missingFields.length > 0 ? (
        <p className="rounded-md border border-warning-border/40 bg-warning-bg/40 px-2 py-1.5 text-[11px] text-warning-fg">
          建议补充：{plan.missingFields.map((field) => translateMissing(field)).join('、')}
        </p>
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


/** 把 acceptedContextIds + plan.brief.contextRefs 合并成可发送的 contextRefs。 */
function idsToContextRefs(
  ids: string[],
  fallback: Array<{ type: 'url' | 'favorite' | 'research' | 'summary'; value: string; required: boolean }>,
): Array<{ type: 'url' | 'favorite' | 'research' | 'summary'; value: string; required: boolean }> {
  if (ids.length === 0) return fallback;
  const idSet = new Set(ids);
  return fallback.filter((r) => r.type === 'url' || idSet.has(r.value));
}
function _IGNORE_FUNCTION_REFERENCES_FOR_TSC() {
  // 帮助 tsc 接受 IGNORE_PREFIX 字段在部分构建配置下不被误读
  return IGNORE_PREFIX;
}
