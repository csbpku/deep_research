// ADR 0010: Research Brief 客户端组件。
//
// 在对话主题明确后，把用户问题喂给 /api/ai-research/plan，拿到
// objective / matching topic / suggested context，渲染为一张连续的
// 研究确认面板；用户可以接受建议或修改。
//
// 研究前只让用户确认一条连续的研究方案：回答什么、参考什么资料、
// 生成什么结果。内部的检索步骤和偏好按需展开，不要求用户先理解系统流程。

'use client';

import React, { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import NextLink from 'next/link';
import {
  BookOpenCheck,
  Loader2,
  Sparkles,
  Tag,
} from 'lucide-react';

import Button from '@mui/material/Button';
import Box from '@mui/material/Box';
import Chip from '@mui/material/Chip';
import Checkbox from '@mui/material/Checkbox';
import CircularProgress from '@mui/material/CircularProgress';
import Link from '@mui/material/Link';
import Paper from '@mui/material/Paper';
import TextField from '@mui/material/TextField';
import MenuItem from '@mui/material/MenuItem';
import Typography from '@mui/material/Typography';
import { friendlyMessage } from '@/lib/errors/friendly';
import { inferDecisionDimensions } from '@/lib/research-plan-semantics';
import type { ResearchScope, ResearchTimeRange } from '@deep-research/shared/schemas';

type Objective = 'explore' | 'learn' | 'investigate' | 'decide';
type ContextSourceRef = {
  type: 'url' | 'favorite' | 'research' | 'summary';
  value: string;
  required: boolean;
};

const OBJECTIVE_LABELS: Record<Objective, string> = {
  explore: '主题概览',
  learn: '系统学习',
  investigate: '机制分析',
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
    decisionDimensions?: string[];
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
  semanticMatch?: boolean;
  confirmedKnowledge?: boolean;
  isExcerpt?: boolean;
  topicMatch?: boolean;
  status?: string;
  updatedAt?: string | null;
  sourceRefs?: ContextSourceRef[];
}

interface BriefProps {
  question: string;
  context: string;
  topicHint?: string;
  initialBrief?: BriefValue | null;
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
  decisionNeedsConfirmation?: boolean;
  brief?: {
    objective: Objective;
    question: string;
    constraints: string[];
    questionsToAnswer: string[];
    comparisonOptions: string[];
    decisionDimensions: string[];
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
export function AiResearchBrief({ question, context, topicHint, initialBrief, children, startAction, onBriefReady, onPlanningChange }: BriefProps) {
  const trimmed = question.trim();
  const isShort = trimmed.length < 2;
  const [state, setState] = useState<FetchState>({ status: 'idle' });
  const [acceptedContextIds, setAcceptedContextIds] = useState<string[]>(initialBrief?.suggestedContextIds ?? []);
  const [selectedContextItems, setSelectedContextItems] = useState<PersonalContextItem[]>([]);
  const [focusText, setFocusText] = useState(initialBrief?.brief?.questionsToAnswer.join('\n') ?? '');
  const [comparisonText, setComparisonText] = useState(initialBrief?.brief?.comparisonOptions.join('\n') ?? '');
  const [objective, setObjective] = useState<Objective>(initialBrief?.objective ?? 'investigate');
  const [timeRange, setTimeRange] = useState<ResearchTimeRange['preset']>(initialBrief?.brief?.scope.timeRange.preset ?? 'any');
  const [scopeFrom, setScopeFrom] = useState(initialBrief?.brief?.scope.timeRange.from ?? '');
  const [scopeTo, setScopeTo] = useState(initialBrief?.brief?.scope.timeRange.to ?? '');
  const [retrievalNotes, setRetrievalNotes] = useState(initialBrief?.brief?.scope.retrievalNotes ?? '');
  const [contextSearch, setContextSearch] = useState('');
  const [contextSearchItems, setContextSearchItems] = useState<PersonalContextItem[]>([]);
  const [contextSearchLoading, setContextSearchLoading] = useState(false);
  const [contextPanelOpen, setContextPanelOpen] = useState(false);
  const selectionRef = useRef<PersonalContextItem[]>([]);
  const editedBriefRef = useRef<BriefValue | null>(initialBrief ?? null);
  const focusTouchedRef = useRef(!!initialBrief?.brief?.questionsToAnswer.length);
  const decisionDimensionsRef = useRef<string[]>(initialBrief?.objective === 'decide' ? initialBrief.brief?.decisionDimensions ?? [] : []);
  const callbacksRef = useRef({ onBriefReady, onPlanningChange });
  callbacksRef.current = { onBriefReady, onPlanningChange };
  const contextSearchQuery = getPersonalContextSearchQuery(contextPanelOpen, contextSearch, trimmed);
  const manualContextSearch = contextPanelOpen && contextSearch.trim().length >= 2;

  useEffect(() => {
    const query = contextSearchQuery;
    if (!query) {
      setContextSearchItems([]);
      setContextSearchLoading(false);
      return;
    }
    let cancelled = false;
    const controller = new AbortController();
    setContextSearchItems([]);
    setContextSearchLoading(true);
    const timer = setTimeout(() => {
      void fetch(buildPersonalContextUrl(query, topicHint, manualContextSearch), { cache: 'no-store', signal: controller.signal })
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
    }, 300);
    return () => {
      cancelled = true;
      clearTimeout(timer);
      controller.abort();
    };
  }, [contextSearchQuery, topicHint, manualContextSearch]);

  useEffect(() => {
    if (isShort) {
      setState({ status: 'idle' });
      callbacksRef.current.onPlanningChange?.(false);
      return;
    }
    let cancelled = false;
    const controller = new AbortController();
    setState((previous) => ({ ...previous, status: 'loading' }));
    callbacksRef.current.onPlanningChange?.(true);
    const timer = setTimeout(() => { void fetch('/api/ai-research/plan', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      signal: controller.signal,
      body: JSON.stringify(buildResearchPlanInput(trimmed, context, topicHint)),
    })
      .then(async (response) => {
        if (!response.ok) {
          if (cancelled) return;
          setState({
            status: 'error',
            error: friendlyMessage(
              { message: `规划请求返回 ${response.status}` } as Error,
              response.status === 401 ? '登录后才能匹配历史专题和已保存研究。' : '规划请求失败，稍后重试。',
            ),
            authRequired: response.status === 401,
          });
          callbacksRef.current.onPlanningChange?.(false);
          return;
        }
        const data = (await response.json()) as PlanResponse;
        if (cancelled) return;
        setState({ status: 'ready', plan: data });
        if (!editedBriefRef.current && data.brief.objective === 'decide') decisionDimensionsRef.current = data.brief.decisionDimensions ?? [];
        const edited = editedBriefRef.current;
        if (edited?.brief?.question === trimmed) {
          callbacksRef.current.onPlanningChange?.(false);
          callbacksRef.current.onBriefReady?.(edited);
          return;
        }
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
        callbacksRef.current.onPlanningChange?.(false);
        const selected = selectionRef.current;
        const selectedIds = selected.map((item) => item.id);
        callbacksRef.current.onBriefReady?.({
          objective: data.brief.objective,
          primaryTopicId: data.brief.primaryTopicId ?? topicHint,
          suggestedContextIds: selectedIds,
          assistantMessage: data.assistantMessage,
          scopeValid: true,
          brief: {
            objective: data.brief.objective,
            question: data.brief.question,
            constraints: data.brief.constraints ?? [],
            questionsToAnswer: data.brief.questionsToAnswer ?? [],
            comparisonOptions: data.brief.comparisonOptions ?? [],
            decisionDimensions: data.brief.decisionDimensions ?? [],
            successCriteria: data.brief.successCriteria ?? [],
            sourcePolicy: data.brief.sourcePolicy ?? 'prefer_user_sources',
            scope: data.brief.scope ?? emptyScope(),
            primaryTopicId: data.brief.primaryTopicId ?? topicHint,
            outputType: data.brief.outputType ?? 'markdown',
            contextRefs: idsToContextRefs(selectedIds, [], selected),
          },
        });
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setState({
          status: 'error',
          error: friendlyMessage(err, '规划请求失败，稍后重试。'),
        });
        callbacksRef.current.onPlanningChange?.(false);
      });
    }, 300);
    return () => {
      cancelled = true;
      clearTimeout(timer);
      controller.abort();
      callbacksRef.current.onPlanningChange?.(false);
    };
  // 重新规划应当由用户主动触发，不在 context 变化时触发
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [trimmed, topicHint]);

  const availableContext = useMemo(() => {
    return mergePersonalContextItems(
      state.plan?.suggestedContext ?? [],
      contextSearchItems,
      selectedContextItems,
    );
  }, [contextSearchItems, selectedContextItems, state.plan]);
  const plan = state.plan;

  if (isShort) {
    return (
      <Paper variant="outlined" sx={{ borderStyle: 'dashed', bgcolor: 'background.paper', p: 1.5, typography: 'metadata', color: 'text.secondary' }}>
        <Box component="span" sx={{ display: 'inline-flex', mr: 0.5, verticalAlign: 'middle' }}>
          <Sparkles size={14} />
        </Box>
        待主题明确后会显示推荐的研究目标和上下文。
      </Paper>
    );
  }

  if ((state.status === 'loading' || state.status === 'idle') && !state.plan) {
    return (
      <PlanningFallback
        loading
        question={trimmed}
        startAction={startAction}
      >
        {children}
        <PersonalContextSuggestions items={availableContext} selectedIds={acceptedContextIds} loading={contextSearchLoading} onToggle={toggleContext} />
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
        <PersonalContextSuggestions items={availableContext} selectedIds={acceptedContextIds} loading={contextSearchLoading} onToggle={toggleContext} />
      </PlanningFallback>
    );
  }

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
    if (!plan) {
      const next: BriefValue = {
        objective, primaryTopicId: topicHint, suggestedContextIds: selectedIds,
        assistantMessage: '', scopeValid: true,
        brief: {
          objective, primaryTopicId: topicHint, question: trimmed,
          constraints: context.trim() ? [context.trim()] : [], questionsToAnswer: [],
          comparisonOptions: [], decisionDimensions: [], successCriteria: [],
          sourcePolicy: 'prefer_user_sources', outputType: 'markdown', scope: emptyScope(),
          contextRefs: idsToContextRefs(selectedIds, editedBriefRef.current?.brief?.contextRefs ?? [], availableContext),
        },
      };
      editedBriefRef.current = next;
      onBriefReady?.(next);
      return;
    }
    const ids = selectedIds;
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
    const explicitDecisionDimensions = inferDecisionDimensions(trimmed, nextFocusText);
    const decisionDimensions = nextObjective === 'decide'
      ? decisionDimensionsRef.current.length ? decisionDimensionsRef.current : explicitDecisionDimensions
      : [];
    const validScope = nextTimeRange !== 'custom'
      || (!!nextScopeFrom && !!nextScopeTo && nextScopeFrom <= nextScopeTo);
    const next: BriefValue = {
      objective: nextObjective,
      primaryTopicId: plan!.brief.primaryTopicId ?? topicHint,
      suggestedContextIds: ids,
      assistantMessage: plan!.assistantMessage,
      scopeValid: validScope,
      decisionNeedsConfirmation: nextObjective === 'decide' && (comparisonOptions.length < 2 || decisionDimensions.length === 0),
      brief: {
        objective: nextObjective,
        question: plan!.brief.question,
        constraints: plan!.brief.constraints ?? [],
        questionsToAnswer,
        comparisonOptions: nextObjective === 'decide' ? comparisonOptions : [],
        decisionDimensions,
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
        contextRefs: idsToContextRefs(ids, editedBriefRef.current?.brief?.contextRefs ?? plan!.brief.contextRefs ?? [], availableContext),
      },
    };
    editedBriefRef.current = next;
    onBriefReady?.(next);
  }

  function handleObjectiveChange(value: Objective) {
    const nextFocus = value === 'decide' && objective !== 'decide' && !focusTouchedRef.current && plan?.brief.objective !== 'decide'
      ? '' : focusText;
    if (nextFocus !== focusText) setFocusText(nextFocus);
    setObjective(value);
    publishPlan({ nextObjective: value, nextFocusText: nextFocus });
  }

  function toggleContext(id: string) {
    const set = new Set(acceptedContextIds);
    if (set.has(id)) {
      set.delete(id);
      selectionRef.current = selectionRef.current.filter((item) => item.id !== id);
    } else {
      if (set.size >= 10) return;
      set.add(id);
      const selectedItem = availableContext.find((item) => item.id === id);
      if (selectedItem) {
        selectionRef.current = mergePersonalContextItems(selectionRef.current, [selectedItem]);
      }
    }
    const next = Array.from(set);
    setSelectedContextItems(selectionRef.current);
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
    <Paper component="div" variant="outlined" sx={{ minWidth: 0, borderColor: 'divider', fontSize: 'var(--dr-type-label)' }}>
      <Box component="header" sx={{ display: 'flex', flexDirection: { xs: 'column', sm: 'row' }, alignItems: 'flex-start', justifyContent: 'space-between', gap: 1.5, borderBottom: 1, borderColor: 'divider', px: 2, py: 1.5 }}>
        <Box>
          <Box component="span" sx={{ display: 'flex', alignItems: 'center', gap: 1, typography: 'listTitle', fontWeight: 600, color: 'text.primary' }}>
            <BookOpenCheck size={18} aria-hidden /> 研究方案
          </Box>
          <Typography component="p" variant="metadata" sx={{ mt: 0.5, lineHeight: 1.6, color: 'text.secondary' }}>确认要回答什么、参考哪些资料和需要什么产出；启动后设置会锁定。</Typography>
        </Box>
        <Box sx={{ display: 'flex', flexShrink: 0, alignSelf: { xs: 'flex-end', sm: 'auto' }, alignItems: 'center', gap: 1 }}>
          <Chip size="small" color="primary" variant="outlined" label={OBJECTIVE_LABELS[objective]} />
        </Box>
      </Box>

      <Box component="section" aria-label="研究方案" sx={{ display: 'grid', minWidth: 0, gap: 3, px: { xs: 2, sm: 3 }, py: 3 }}>
        <Box sx={{ display: 'flex', flexWrap: 'wrap', alignItems: 'baseline', justifyContent: 'space-between', gap: 1 }}>
          <Typography component="h3" variant="body2" sx={{ fontWeight: 500 }}>研究什么</Typography>
          <Typography component="span" variant="metadata" color="text.secondary">AI 已根据问题整理，可调整</Typography>
        </Box>

        <TextField select label="研究方式" value={objective} onChange={event => handleObjectiveChange(event.target.value as Objective)} sx={{ width: { xs: '100%', sm: 200 } }}>
          {(Object.keys(OBJECTIVE_LABELS) as Objective[]).map(value => <MenuItem key={value} value={value}>{OBJECTIVE_LABELS[value]}</MenuItem>)}
        </TextField>

      <Typography component="p" variant="metadata" sx={{ lineHeight: 1.6, color: 'text.secondary' }}>
        {objectiveChanged
          ? `已调整为「${OBJECTIVE_LABELS[objective]}」；提交时以当前目标、重点问题和对比对象为准。`
          : planStatusText}
      </Typography>

      {resolvedPlan.plan || resolvedPlan.brief.successCriteria?.length ? (
        <Box component="details" sx={{ border: 1, borderColor: 'divider', borderRadius: 1, bgcolor: 'action.hover' }}>
          <Box component="summary" sx={{ display: 'flex', cursor: 'pointer', listStyle: 'none', alignItems: 'center', justifyContent: 'space-between', gap: 1, px: 1.5, py: 1, fontWeight: 500, color: 'text.primary', '&::-webkit-details-marker': { display: 'none' } }}>
            <Box component="span">AI 会怎样完成这次研究？</Box>
            <Typography component="span" variant="metadata" sx={{ fontWeight: 400, color: 'text.secondary' }}>研究路径与完成标准</Typography>
          </Box>
          <Box sx={{ display: 'grid', gap: 1, borderTop: 1, borderColor: 'divider', px: 1.5, py: 1 }}>
            {resolvedPlan.plan ? (
              <div>
                <Typography component="p" variant="body2" sx={{ fontWeight: 500 }}>
                  {objectiveChanged
                    ? objective === 'decide' && currentComparisons.length > 0
                      ? `对比 ${currentComparisons.join('、')}，并形成有证据支撑的优先级建议。`
                      : `按「${OBJECTIVE_LABELS[objective]}」目标组织证据并生成结论。`
                    : resolvedPlan.plan.summary}
                </Typography>
                <Typography component="p" variant="metadata" sx={{ mt: 0.5, color: 'text.secondary' }}>
                  预计需要几分钟到十几分钟；可以离开页面，完成后再回来查看。
                </Typography>
                {resolvedPlan.plan.steps?.length ? (
                  <Box component="ul" sx={{ mt: 1, pt: 1, display: 'flex', flexWrap: 'wrap', columnGap: 1.5, rowGap: 0.5, borderTop: 1, borderColor: 'divider', color: 'text.secondary', listStyle: 'none', m: 0, pl: 0 }}>
                    {resolvedPlan.plan.steps.slice(0, 4).map((step) => <Box component="li" key={step.title}><Box component="span" aria-hidden="true">·</Box>{' '}{step.title}</Box>)}
                  </Box>
                ) : null}
              </div>
            ) : null}
            {resolvedPlan.brief.successCriteria?.length ? (
              <Box sx={{ borderTop: 1, borderColor: 'divider', pt: 1 }}>
                <Typography component="p" variant="body2" sx={{ fontWeight: 500 }}>完成标准</Typography>
                <Box component="ul" sx={{ mt: 0.5, display: 'grid', gap: 0.5, p: 0, listStyle: 'none', typography: 'metadata', lineHeight: 1.6, color: 'text.secondary' }}>
                  {resolvedPlan.brief.successCriteria.slice(0, 4).map((criterion) => (
                    <Box component="li" key={criterion} sx={{ display: 'flex', gap: 1 }}>
                      <Box component="span" sx={{ color: 'primary.main' }} aria-hidden="true">✓</Box>
                      <Box component="span">{criterion}</Box>
                    </Box>
                  ))}
                </Box>
              </Box>
            ) : null}
          </Box>
        </Box>
      ) : null}

      <Box sx={{ display: 'grid', gap: 1.5, gridTemplateColumns: objective === 'decide' ? { xs: '1fr', md: 'repeat(2, minmax(0, 1fr))' } : '1fr' }}>
        <Box component="label" sx={{ display: 'grid', gap: 1 }}>
          <Typography component="span" variant="body2" sx={{ fontWeight: 500 }}>重点回答</Typography>
          <TextField
            fullWidth
            multiline
            value={focusText}
            onChange={(event) => {
              const next = event.target.value;
              focusTouchedRef.current = true;
              setFocusText(next);
              publishPlan({ nextFocusText: next });
            }}
            rows={2}
            placeholder="例如：上线成本\n团队维护复杂度\n适合什么时候采用"
            aria-label="研究重点回答"
            sx={{ '& .MuiOutlinedInput-root': { alignItems: 'flex-start' }, '& textarea': { resize: 'vertical' } }}
          />
        </Box>

        {objective === 'decide' ? (
          <Box component="label" sx={{ display: 'grid', gap: 1 }}>
              <Typography component="span" variant="body2" sx={{ fontWeight: 500 }}>对比对象</Typography>
            <TextField
              fullWidth
              multiline
              value={comparisonText}
              onChange={(event) => {
                const next = event.target.value;
                setComparisonText(next);
                publishPlan({ nextComparisonText: next });
              }}
              rows={2}
              placeholder="例如：Claude Research\nGemini Deep Research\nChatGPT Deep Research"
              aria-label="研究对比对象"
              sx={{ '& .MuiOutlinedInput-root': { alignItems: 'flex-start' }, '& textarea': { resize: 'vertical' } }}
            />
          </Box>
        ) : null}
      </Box>

      {children ? (
        <Box sx={{ borderTop: 1, borderColor: 'divider', pt: 2 }} aria-label="资料与产出">
          {children}
        </Box>
      ) : null}
      </Box>

      <Box component="details" sx={{ borderTop: 1, borderColor: 'divider' }}>
        <Box component="summary" sx={{ cursor: 'pointer', px: { xs: 2, sm: 3 }, py: 2, color: 'info.main', typography: 'body2', fontWeight: 600 }}>历史资料建议（可选） · 已选 {acceptedContextIds.length} 条</Box>
      <PersonalContextSuggestions
        items={availableContext}
        selectedIds={acceptedContextIds}
        loading={contextSearchLoading}
        onToggle={toggleContext}
      />
      </Box>

      <Box component="section" aria-label="更多设置" sx={{ borderTop: 1, borderColor: 'divider', px: 2, py: 1.5 }}>
        <Box sx={{ mb: 1 }}>
          <Typography component="h3" variant="body2" sx={{ fontWeight: 500 }}>更多设置</Typography>
          <Typography component="p" variant="metadata" sx={{ mt: 0.5, lineHeight: 1.6, color: 'text.secondary' }}>默认由 AI 安排；只有有明确偏好时再调整。</Typography>
        </Box>
        <Box sx={{ display: 'grid', gap: 1 }} aria-label="更多检索设置">
      <Box component="details" sx={{ border: 1, borderColor: 'divider', borderRadius: 1, bgcolor: 'background.default' }}>
        <Box component="summary" sx={{ display: 'flex', cursor: 'pointer', listStyle: 'none', alignItems: 'center', justifyContent: 'space-between', gap: 1, px: 1.5, py: 1, fontWeight: 500, color: 'text.primary', '&::-webkit-details-marker': { display: 'none' } }}>
          <Box component="span">检索偏好（可选）</Box>
          <Typography component="span" variant="metadata" sx={{ fontWeight: 400, color: 'text.secondary' }}>{hasSearchPreferences ? '已设置' : '只在需要时展开'}</Typography>
        </Box>
        <Box sx={{ display: 'grid', gap: 1, borderTop: 1, borderColor: 'divider', px: 1.5, py: 1 }}>
          <Typography component="p" variant="metadata" sx={{ lineHeight: 1.6, color: 'text.secondary' }}>告诉 AI 先看什么、重点关注什么；不填写表示由 AI 自行安排。</Typography>
          <Box component="fieldset" sx={{ display: 'grid', gap: 0.5, m: 0, p: 0, border: 0, minWidth: 0 }}>
            <Box component="legend" sx={{ mb: 0.5, p: 0, fontWeight: 500, color: 'text.primary' }}>优先参考时间</Box>
            <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 1 }}>
              {TIME_RANGE_OPTIONS.map((option) => (
                <Button
                  key={option.value}
                  type="button"
                  aria-pressed={timeRange === option.value}
                  size="small"
                  variant={timeRange === option.value ? 'contained' : 'outlined'}
                  onClick={() => {
                    setTimeRange(option.value);
                    publishPlan({ nextTimeRange: option.value });
                  }}
                  sx={{ minHeight: 32, borderRadius: 'var(--dr-radius-pill)', px: 1.5 }}
                >
                  {option.label}
                </Button>
              ))}
            </Box>
          </Box>
          {timeRange === 'custom' ? (
            <Box sx={{ display: 'grid', gridTemplateColumns: { xs: '1fr', sm: 'repeat(2, minmax(0, 1fr))' }, gap: 1 }}>
              <Box component="label" sx={{ display: 'grid', gap: 0.5 }}>
            <Typography component="span" variant="metadata" color="text.secondary">起始日期</Typography>
                <TextField
                  fullWidth
                  type="date"
                  value={scopeFrom}
                  aria-invalid={scopeIncomplete && (!scopeFrom || scopeFrom > scopeTo) ? true : undefined}
                  onChange={(event) => {
                    const next = event.target.value;
                    setScopeFrom(next);
                    publishPlan({ nextScopeFrom: next });
                  }}
                  aria-label="优先参考起始日期"
                  slotProps={{ htmlInput: { max: scopeTo || undefined } }}
                  sx={{ minWidth: 0 }}
                />
              </Box>
              <Box component="label" sx={{ display: 'grid', gap: 0.5 }}>
                <Typography component="span" variant="metadata" color="text.secondary">结束日期</Typography>
                <TextField
                  fullWidth
                  type="date"
                  value={scopeTo}
                  aria-invalid={scopeIncomplete && (!scopeTo || scopeFrom > scopeTo) ? true : undefined}
                  onChange={(event) => {
                    const next = event.target.value;
                    setScopeTo(next);
                    publishPlan({ nextScopeTo: next });
                  }}
                  aria-label="优先参考结束日期"
                  slotProps={{ htmlInput: { min: scopeFrom || undefined } }}
                  sx={{ minWidth: 0 }}
                />
              </Box>
            </Box>
          ) : null}
          <Box component="label" sx={{ display: 'grid', gap: 0.5 }}>
            <Typography component="span" variant="metadata" color="text.secondary">关注点或偏好</Typography>
            <TextField
              fullWidth
              multiline
              value={retrievalNotes}
              onChange={(event) => {
                const next = event.target.value;
                setRetrievalNotes(next);
                publishPlan({ nextRetrievalNotes: next });
              }}
              rows={2}
              placeholder="例如：优先官方文档；关注迁移和兼容性"
              aria-label="检索关注点或偏好"
              slotProps={{ htmlInput: { maxLength: 400 } }}
              sx={{ '& .MuiOutlinedInput-root': { alignItems: 'flex-start' }, '& textarea': { resize: 'vertical' } }}
            />
          </Box>
          {scopeIncomplete ? (
            <Box component="p" role="alert" sx={{ border: 1, borderColor: 'warning.main', borderRadius: 1, bgcolor: 'var(--dr-color-warning-container)', px: 1, py: 1, typography: 'metadata', lineHeight: 1.6, color: 'warning.main' }}>
              请同时填写开始和结束日期；结束日期不能早于开始日期。补全后才能启动研究。
            </Box>
          ) : null}
          <Typography component="p" variant="metadata" sx={{ lineHeight: 1.6, color: 'text.secondary' }}>时间只影响检索优先级；网页可能没有可靠的发布日期。</Typography>
        </Box>
      </Box>

      <Box
        component="details"
        sx={{ border: 1, borderColor: 'divider', borderRadius: 1, bgcolor: 'background.default' }}
        onToggle={(event) => setContextPanelOpen(event.currentTarget.open)}
      >
        <Box
          component="summary"
          onClick={(event) => {
            const details = event.currentTarget.parentElement as HTMLDetailsElement;
            setContextPanelOpen(!details.open);
          }}
          aria-expanded={contextPanelOpen}
          sx={{ display: 'flex', cursor: 'pointer', listStyle: 'none', alignItems: 'center', justifyContent: 'space-between', gap: 1, px: 1.5, py: 1, fontWeight: 500, color: 'text.primary', '&::-webkit-details-marker': { display: 'none' } }}
        >
          <Box component="span" sx={{ display: 'flex', alignItems: 'center', gap: 1 }}><Tag size={12} />已有资料（可选）</Box>
          <Typography component="span" variant="metadata" sx={{ fontWeight: 400, color: 'text.secondary' }}>历史研究、知识库、收藏、专题议题</Typography>
        </Box>
        <Box sx={{ display: 'grid', gap: 1, borderTop: 1, borderColor: 'divider', px: 1.5, py: 1 }}>
          <Typography component="p" variant="metadata" sx={{ lineHeight: 1.6, color: 'text.secondary' }}>只会把你选中的资料带入本次研究；不选择也可以直接搜索网页。</Typography>
          <Box component="label" sx={{ display: 'grid', gap: 0.5 }}>
          <Typography component="span" variant="metadata" color="text.secondary">搜索可用资料（历史研究、知识库、收藏与专题议题）</Typography>
            <TextField
              fullWidth
              value={contextSearch}
              onChange={(event) => setContextSearch(event.target.value)}
              placeholder="按标题或正文关键词搜索"
              aria-label="搜索个人资料"
              sx={{ minWidth: 0 }}
            />
          </Box>
          <Typography component="p" variant="metadata" sx={{ lineHeight: 1.6, color: 'text.secondary' }}>只显示你有权限使用的资料；选中后会随本次研究保存为来源。</Typography>
        </Box>
      </Box>
        </Box>
      </Box>

      {missingFields.length > 0 ? (
        <Typography component="p" variant="metadata" sx={{ borderTop: 1, borderColor: 'warning.main', bgcolor: 'var(--dr-color-warning-container)', px: 2, py: 1, color: 'warning.main' }}>
          建议补充：{missingFields.map((field) => translateMissing(field)).join('、')}
        </Typography>
      ) : null}
      <Box component="footer" sx={{ position: 'sticky', bottom: 0, zIndex: 1, display: 'flex', flexWrap: 'wrap', justifyContent: 'space-between', alignItems: 'center', gap: 1.5, px: { xs: 2, sm: 3 }, py: 2, bgcolor: 'background.paper', borderTop: 1, borderColor: 'divider' }}>
        <Typography variant="metadata" color="text.secondary">确认以上设置，启动后将锁定。</Typography>
        {startAction}
      </Box>
    </Paper>
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
    <Paper variant="outlined" sx={{ minWidth: 0, borderColor: 'divider', bgcolor: 'background.paper', typography: 'metadata' }}>
      <Box component="header" sx={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 1.5, borderBottom: 1, borderColor: 'divider', px: 2, py: 1.5 }}>
        <Box>
          <Box component="span" sx={{ display: 'flex', alignItems: 'center', gap: 1, typography: 'listTitle', fontWeight: 600, color: 'text.primary' }}>
            <BookOpenCheck size={18} aria-hidden /> 研究方案
          </Box>
          <Typography component="p" variant="metadata" sx={{ mt: 0.5, maxWidth: '36rem', lineHeight: 1.6, color: 'text.secondary' }}>
            {loading ? '研究方案正在生成；你可以先调整资料和产出，也可以直接开始。' : '研究方案暂时不可用；你仍可以按当前问题直接开始，完成后再补充方案。'}
          </Typography>
        </Box>
        <Box sx={{ display: 'flex', flexShrink: 0, alignItems: 'center', gap: 1 }}>
          <Chip size="small" color={loading ? 'default' : 'primary'} variant="outlined" label={loading ? '计划生成中' : '可直接开始'} />
        </Box>
      </Box>
      <Box component="section" aria-label="研究方案" sx={{ display: 'grid', minWidth: 0, gap: 3, px: { xs: 2, sm: 3 }, py: 3 }}>
          <Box sx={{ display: 'flex', flexWrap: 'wrap', alignItems: 'baseline', justifyContent: 'space-between', gap: 1 }}>
            <Typography component="h3" variant="body2" sx={{ fontWeight: 500 }}>研究什么</Typography>
            <Typography component="span" variant="metadata" color="text.secondary">{loading ? '正在整理研究角度' : '当前问题仍可执行'}</Typography>
          </Box>
          {loading ? (
            <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, border: 1, borderColor: 'divider', borderRadius: 1, bgcolor: 'action.hover', px: 1.5, py: 1.5, typography: 'metadata', color: 'text.secondary' }} role="status">
              <CircularProgress size={14} thickness={5} sx={{ flexShrink: 0, color: 'primary.main' }} aria-hidden />
              正在为「{question.slice(0, 32)}{question.length > 32 ? '…' : ''}」整理研究角度和已有资料…
            </Box>
          ) : (
            <Box role="alert" sx={{ border: 1, borderColor: 'warning.main', borderRadius: 1, bgcolor: 'var(--dr-color-warning-container)', px: 1.5, py: 1, typography: 'metadata', lineHeight: 1.6, color: 'warning.main' }}>
              <Typography component="p" variant="metadata">{error}</Typography>
              <Box sx={{ mt: 0.5, display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 1 }}>
                <Box component="span">计划不影响启动；你可以先按当前问题研究。</Box>
                {authRequired ? (
                  <Link component={NextLink} href="/signin?callbackUrl=%2Fai-research" underline="always" sx={{ fontWeight: 500, textUnderlineOffset: 2 }}>登录后重试</Link>
                ) : null}
              </Box>
            </Box>
          )}
      </Box>
      {children ? (
        <Box component="section" aria-label="资料与产出" sx={{ borderTop: 1, borderColor: 'divider', px: { xs: 2, sm: 3 }, py: 3 }}>
          {children}
        </Box>
      ) : null}
      <Box component="footer" sx={{ display: 'flex', justifyContent: 'flex-end', p: 2, borderTop: 1, borderColor: 'divider' }}>{startAction}</Box>
    </Paper>
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
export function idsToContextRefs(
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

export function mergePersonalContextItems(
  ...groups: ReadonlyArray<ReadonlyArray<PersonalContextItem>>
): PersonalContextItem[] {
  const merged = new Map<string, PersonalContextItem>();
  for (const group of groups) {
    for (const item of group) merged.set(`${item.kind}:${item.id}`, item);
  }
  return Array.from(merged.values());
}

export function getPersonalContextSearchQuery(
  panelOpen: boolean,
  searchText: string,
  researchQuestion: string,
): string | null {
  const query = (panelOpen && searchText.trim() ? searchText.trim() : researchQuestion.trim()).slice(0, 2000);
  return query.length >= 2 ? query : null;
}

export function buildPersonalContextUrl(query: string, topicHint?: string, manual = false): string {
  const params = new URLSearchParams({ q: query.slice(0, 2000) });
  if (topicHint) params.set('topicHint', topicHint);
  if (manual) {
    params.set('manual', '1');
    params.set('semantic', '1');
  }
  return `/api/ai-research/context?${params.toString()}`;
}

export function buildResearchPlanInput(question: string, context: string, topicHint?: string) {
  return {
    question: question.trim(),
    ...(context.trim() ? { context: context.trim() } : {}),
    ...(topicHint ? { topicHint } : {}),
  };
}

export function PersonalContextSuggestions({
  items, selectedIds, loading, onToggle,
}: {
  items: PersonalContextItem[];
  selectedIds: string[];
  loading: boolean;
  onToggle: (id: string) => void;
}) {
  const selected = items.filter((item) => selectedIds.includes(item.id));
  const visible = mergePersonalContextItems(selected, items.slice(0, 12));
  return (
    <Box component="section" aria-label="相关历史判断与资料" aria-busy={loading} sx={{ display: 'grid', gap: 1, borderTop: 1, borderColor: 'divider', px: 2, py: 1.5 }}>
      <Typography component="h3" variant="body2" sx={{ fontWeight: 500 }}>相关历史判断与资料</Typography>
      <Typography component="p" variant="metadata" sx={{ lineHeight: 1.6, color: 'text.secondary' }}>仅选中的资料用于本次研究；历史判断不代表本次结论。</Typography>
      {visible.map((item) => (
        <Box component="label" key={`${item.kind}:${item.id}`} sx={{ display: 'flex', cursor: 'pointer', alignItems: 'flex-start', gap: 1, borderBottom: 1, borderColor: 'divider', py: 1, '&:last-of-type': { borderBottom: 0 } }}>
          <Checkbox
            size="small"
            checked={selectedIds.includes(item.id)}
            disabled={selectedIds.length >= 10 && !selectedIds.includes(item.id)}
            onChange={() => onToggle(item.id)}
            slotProps={{ input: { 'aria-label': `使用资料：${item.title}` } }}
            sx={{ flexShrink: 0 }}
          />
          <Box component="span" sx={{ display: 'grid', minWidth: 0, flex: 1, gap: 0.5 }}>
            <Box component="span" sx={{ display: 'block', overflowWrap: 'anywhere', fontWeight: 500, color: 'text.primary' }}>{item.title}</Box>
            <Box component="span" sx={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 0.5, typography: 'metadata', color: 'text.secondary' }}>
              <Chip size="small" variant="outlined" label={item.isExcerpt ? '未确认摘录' : item.confirmedKnowledge ? '已确认知识' : contextKindLabel(item.kind)} />
              {item.private ? <Chip size="small" color="primary" variant="outlined" label="仅本人" /> : null}
              {item.topicMatch ? <Chip size="small" variant="outlined" label="同专题" /> : null}
              {item.semanticMatch ? <Chip size="small" variant="outlined" label="语义匹配" /> : null}
              {item.status ? <span>{item.status === 'published' ? '已发布' : item.status === 'draft' ? '草稿' : item.status === 'active' ? '跟踪中' : item.status}</span> : null}
              {item.updatedAt ? <time dateTime={item.updatedAt}>{item.updatedAt.slice(0, 10)}</time> : null}
            </Box>
            <Typography component="span" variant="metadata" sx={{ display: 'block', overflowWrap: 'anywhere', lineHeight: 1.6, color: 'text.secondary' }}>{item.snippet}</Typography>
          </Box>
        </Box>
      ))}
      {loading ? <Typography component="p" variant="metadata" role="status" color="text.secondary">正在查找相关资料…</Typography> : null}
      {!loading && !visible.length ? <Typography component="p" variant="metadata" color="text.secondary">暂无相关资料，可在「已有资料」中按关键词搜索。</Typography> : null}
    </Box>
  );
}

function _IGNORE_FUNCTION_REFERENCES_FOR_TSC() {
  // 帮助 tsc 接受 IGNORE_PREFIX 字段在部分构建配置下不被误读
  return IGNORE_PREFIX;
}

