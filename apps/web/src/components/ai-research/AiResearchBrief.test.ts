import { afterEach, describe, expect, it, vi } from 'vitest';
import { createElement, isValidElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

// Exercise the component's effects in the existing node-only suite without
// adding a DOM/test-renderer dependency. MUI descendants remain React elements.
const hookRuntime = vi.hoisted(() => ({
  current: undefined as Record<string, (...args: unknown[]) => unknown> | undefined,
}));
vi.mock('react', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react')>();
  return {
    ...actual,
    ...Object.fromEntries(['useState', 'useRef', 'useMemo', 'useEffect'].map((name) => [
      name,
      (...args: unknown[]) => hookRuntime.current
        ? hookRuntime.current[name](...args)
        : Reflect.apply(actual[name as 'useState'], undefined, args),
    ])),
  };
});

import {
  AiResearchBrief,
  buildPersonalContextUrl,
  buildResearchPlanInput,
  getPersonalContextSearchQuery,
  idsToContextRefs,
  mergePersonalContextItems,
  PersonalContextSuggestions,
} from './AiResearchBrief';

describe('AI research context selection', () => {
  const suggestions = [
    {
      kind: 'knowledge' as const,
      id: 'private-knowledge-1',
      title: 'Private judgement',
      snippet: 'Only the confirmed judgement',
      private: true,
      semanticMatch: true,
      sourceRefs: [{ type: 'research' as const, value: 'private-knowledge-1', required: false }],
    },
    {
      kind: 'research' as const,
      id: 'private-report-2',
      title: 'Private report',
      snippet: 'A separate draft',
      private: true,
      sourceRefs: [{ type: 'research' as const, value: 'private-report-2', required: false }],
    },
  ];

  it('does not inject suggested knowledge until the user selects it', () => {
    expect(idsToContextRefs([], [
      { type: 'url', value: 'https://example.com/explicit', required: false },
      { type: 'research', value: 'seed-research', required: false },
    ], suggestions)).toEqual([
      { type: 'url', value: 'https://example.com/explicit', required: false },
    ]);
  });

  it('adds only the selected item and its source refs', () => {
    expect(idsToContextRefs(['private-knowledge-1'], [], suggestions)).toEqual([
      { type: 'research', value: 'private-knowledge-1', required: false },
    ]);
  });

  it('keeps selected candidates available when the active query results change', () => {
    const nextQueryResults = [{
      kind: 'research' as const,
      id: 'another-result',
      title: 'Another result',
      snippet: 'Current query result',
    }];

    expect(mergePersonalContextItems([], nextQueryResults, [suggestions[0]!])).toEqual([
      nextQueryResults[0],
      suggestions[0],
    ]);
  });

  it('automatically looks up a meaningful question before opening search settings', () => {
    expect(getPersonalContextSearchQuery(false, '', 'How should we validate retrieval?')).toBe(
      'How should we validate retrieval?',
    );
    expect(getPersonalContextSearchQuery(true, '', '  How should we validate retrieval?  ')).toBe(
      'How should we validate retrieval?',
    );
    expect(getPersonalContextSearchQuery(true, '  private notes  ', 'Research question')).toBe('private notes');
    expect(getPersonalContextSearchQuery(true, '', 'x')).toBeNull();
    expect(getPersonalContextSearchQuery(false, 'manual search', 'RAG')).toBe('RAG');
    expect(getPersonalContextSearchQuery(false, '', 'x'.repeat(4000))).toHaveLength(2000);
  });

  it('propagates the topic hint to planning and automatic/manual context requests', () => {
    expect(buildResearchPlanInput('RAG', '  official docs  ', 'topic-id')).toEqual({
      question: 'RAG', context: 'official docs', topicHint: 'topic-id',
    });
    const automatic = new URL(buildPersonalContextUrl('GraphRAG 成本', 'topic-id'), 'http://test');
    expect(automatic.searchParams.get('q')).toBe('GraphRAG 成本');
    expect(automatic.searchParams.get('topicHint')).toBe('topic-id');
    expect(automatic.searchParams.has('semantic')).toBe(false);
    expect(automatic.searchParams.has('manual')).toBe(false);
    const manual = new URL(buildPersonalContextUrl('GraphRAG', 'topic-id', true), 'http://test');
    expect(manual.searchParams.get('manual')).toBe('1');
    expect(manual.searchParams.get('semantic')).toBe('1');
  });

  it('does not clip questions or accumulated background during planning', () => {
    const question = 'Grok Bot '.repeat(500);
    const context = 'Long detailed requirements. '.repeat(300);
    expect(buildResearchPlanInput(question, context)).toEqual({
      question: question.trim(), context: context.trim(),
    });
  });

  it('preserves explicitly selected refs through suggestion refreshes without adopting new results', () => {
    const next = { ...suggestions[1], id: 'new-result', title: 'New result' };
    const refreshed = mergePersonalContextItems([next], [suggestions[0]]);
    expect(idsToContextRefs(['private-knowledge-1'], [], refreshed)).toEqual([
      { type: 'research', value: 'private-knowledge-1', required: false },
    ]);
    expect(idsToContextRefs([], [], refreshed)).toEqual([]);
  });

  it('renders confirmed judgment, source, status and date with unchecked opt-in controls', () => {
    const html = renderToStaticMarkup(createElement(PersonalContextSuggestions, {
      items: [{ ...suggestions[0], confirmedKnowledge: true, topicMatch: true, status: 'draft', updatedAt: '2026-10-19T00:00:00Z' }],
      selectedIds: [], loading: false, onToggle: () => undefined,
    }));
    expect(html).toContain('相关历史判断与资料');
    expect(html).toContain('已确认知识');
    expect(html).toContain('仅本人');
    expect(html).toContain('同专题');
    expect(html).toContain('草稿');
    expect(html).toContain('2026-10-19');
    expect(html).toContain('Only the confirmed judgement');
    expect(html).toContain('type="checkbox"');
    expect(html).not.toContain('checked=""');
    expect(html).not.toContain('<details');
  });

  it('keeps selected results visible even beyond the suggestion limit', () => {
    const html = renderToStaticMarkup(createElement(PersonalContextSuggestions, {
      items: [
        ...Array.from({ length: 12 }, (_, i) => ({ ...suggestions[1], id: `new-${i}`, title: `New ${i}` })),
        suggestions[0],
      ],
      selectedIds: ['private-knowledge-1'], loading: false, onToggle: () => undefined,
    }));
    expect(html).toContain('Private judgement');
    expect(html).toContain('checked=""');
  });

  it('renders the suggestion area for a meaningful question while the plan is still loading', () => {
    const html = renderToStaticMarkup(createElement(AiResearchBrief, { question: 'RAG', context: '' }));
    expect(html).toContain('相关历史判断与资料');
  });

  it('does not label a manually found excerpt as a confirmed judgment', () => {
    const html = renderToStaticMarkup(createElement(PersonalContextSuggestions, {
      items: [{ ...suggestions[0], confirmedKnowledge: false, isExcerpt: true }],
      selectedIds: [], loading: false, onToggle: () => undefined,
    }));
    expect(html).toContain('未确认摘录');
    expect(html).not.toContain('已确认知识');
  });
});

type BriefProps = Parameters<typeof AiResearchBrief>[0];
type SuggestionProps = Parameters<typeof PersonalContextSuggestions>[0];

function mountBrief(initialProps: BriefProps) {
  let props = initialProps;
  let cursor = 0;
  let dirty = false;
  let output: ReactNode;
  const slots: Array<{ value?: unknown; deps?: readonly unknown[]; cleanup?: () => void }> = [];
  const effects: Array<() => void> = [];
  const changed = (a?: readonly unknown[], b?: readonly unknown[]) => (
    !a || !b || a.length !== b.length || a.some((item, i) => !Object.is(item, b[i]))
  );
  const runtime = {
    useState(initial: unknown) {
      const index = cursor++;
      if (!slots[index]) slots[index] = { value: typeof initial === 'function' ? initial() : initial };
      return [slots[index].value, (next: unknown) => {
        const value = typeof next === 'function' ? next(slots[index].value) : next;
        if (!Object.is(value, slots[index].value)) dirty = true;
        slots[index].value = value;
      }];
    },
    useRef(initial: unknown) {
      const index = cursor++;
      if (!slots[index]) slots[index] = { value: { current: initial } };
      return slots[index].value;
    },
    useMemo(factory: unknown, deps: unknown) {
      const index = cursor++;
      if (changed(slots[index]?.deps, deps as readonly unknown[])) {
        slots[index] = { deps: deps as readonly unknown[], value: (factory as () => unknown)() };
      }
      return slots[index].value;
    },
    useEffect(effect: unknown, deps: unknown) {
      const index = cursor++;
      if (!changed(slots[index]?.deps, deps as readonly unknown[])) return;
      const previous = slots[index]?.cleanup;
      slots[index] = { deps: deps as readonly unknown[] };
      effects.push(() => {
        previous?.();
        const cleanup = (effect as () => void | (() => void))();
        if (typeof cleanup === 'function') slots[index].cleanup = cleanup;
      });
    },
  };
  const flush = () => {
    let renders = 0;
    do {
      if (++renders > 20) throw new Error('Brief did not settle');
      cursor = 0;
      dirty = false;
      hookRuntime.current = runtime;
      try { output = AiResearchBrief(props); } finally { hookRuntime.current = undefined; }
      for (const effect of effects.splice(0)) effect();
    } while (dirty);
  };
  function findSuggestions(node: ReactNode): SuggestionProps | undefined {
    if (Array.isArray(node)) {
      for (const child of node) {
        const found = findSuggestions(child);
        if (found) return found;
      }
    }
    if (!isValidElement<{ children?: ReactNode }>(node)) return undefined;
    if (node.type === PersonalContextSuggestions) return node.props as SuggestionProps;
    return findSuggestions(node.props.children);
  }
  flush();
  return {
    flush,
    changeObjective(value: string) {
      function find(node: ReactNode): ((event: { target: { value: string } }) => void) | undefined {
        if (Array.isArray(node)) { for (const child of node) { const found = find(child); if (found) return found; } return; }
        if (!isValidElement<{ children?: ReactNode; label?: string; select?: boolean; onChange?: (event: { target: { value: string } }) => void }>(node)) return;
        if (node.props.label === '研究方式' && node.props.select) return node.props.onChange;
        return find(node.props.children);
      }
      const change = find(output); if (!change) throw new Error('Research objective selector not found'); change({ target: { value } }); flush();
    },
    changeField(label: string, value: string) {
      function find(node: ReactNode): ((event: { target: { value: string } }) => void) | undefined {
        if (Array.isArray(node)) { for (const child of node) { const found = find(child); if (found) return found; } return; }
        if (!isValidElement<{ children?: ReactNode; 'aria-label'?: string; onChange?: (event: { target: { value: string } }) => void }>(node)) return;
        if (node.props['aria-label'] === label && node.props.onChange) return node.props.onChange;
        return find(node.props.children);
      }
      const change = find(output); if (!change) throw new Error(`Field ${label} not found`); change({ target: { value } }); flush();
    },
    update(next: Partial<BriefProps>) { props = { ...props, ...next }; flush(); },
    suggestions() {
      const found = findSuggestions(output);
      if (!found) throw new Error('Suggestions missing');
      return found;
    },
    unmount() { for (const slot of slots) slot.cleanup?.(); },
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

function planResponse(question: string, suggestedContext: SuggestionProps['items'] = []) {
  return {
    assistantMessage: 'Ready', ready: true, missingFields: [], suggestedTopics: [], suggestedContext,
    brief: {
      question, objective: 'investigate', outputType: 'markdown', sourcePolicy: 'prefer_user_sources',
      scope: { timeRange: { preset: 'any' }, regions: [], technologyVersions: [], retrievalNotes: '' },
      questionsToAnswer: ['Verify evidence'], contextRefs: [],
    },
  };
}

describe('AI research brief client request races', () => {
  let mounted: ReturnType<typeof mountBrief> | undefined;
  afterEach(() => {
    mounted?.unmount();
    mounted = undefined;
    hookRuntime.current = undefined;
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  function setup() {
    vi.useFakeTimers();
    const requests: Array<{ url: string; init?: RequestInit; response: ReturnType<typeof deferred<Response>> }> = [];
    // Deliberately ignore abort in the fake server to exercise stale-response
    // guards, not just the AbortController's happy path.
    vi.stubGlobal('fetch', vi.fn((url: string, init?: RequestInit) => {
      const response = deferred<Response>();
      requests.push({ url, init, response });
      return response.promise;
    }));
    const ready = vi.fn();
    mounted = mountBrief({
      question: 'GraphRAG retrieval costs', context: '',
      topicHint: '22222222-2222-4222-8222-222222222222', onBriefReady: ready,
    });
    return { requests, ready, brief: mounted };
  }
  const respond = (request: { response: ReturnType<typeof deferred<Response>> }, body: unknown) => {
    request.response.resolve(new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } }));
  };
  const knowledge = {
    kind: 'knowledge' as const, id: 'confirmed-1', title: 'Confirmed GraphRAG decision', snippet: 'Validate costs first.',
    private: true, confirmedKnowledge: true,
    sourceRefs: [{ type: 'research' as const, value: 'confirmed-1', required: false }],
  };

  it('drops hidden comparison requirements when changing from comparison to learning', async () => {
    const { brief, requests, ready } = setup();
    await vi.advanceTimersByTimeAsync(300);
    for (const request of requests) {
      const plan = planResponse('GraphRAG retrieval costs');
      respond(request, request.url.endsWith('/plan') ? { ...plan, brief: { ...plan.brief, objective: 'decide', comparisonOptions: ['A', 'B'], decisionDimensions: ['成本'] } } : { items: [] });
    }
    await vi.advanceTimersByTimeAsync(0); brief.flush();
    brief.changeObjective('learn');
    expect(ready.mock.calls.at(-1)![0].brief).toMatchObject({ objective: 'learn', comparisonOptions: [], decisionDimensions: [] });
  });

  it('keeps an explicitly edited question when switching to decision research', async () => {
    const { brief, requests, ready } = setup();
    await vi.advanceTimersByTimeAsync(300);
    for (const request of requests) respond(request, request.url.endsWith('/plan') ? planResponse('GraphRAG retrieval costs') : { items: [] });
    await vi.advanceTimersByTimeAsync(0); brief.flush();
    brief.changeField('研究重点回答', '核对性能与成本');
    brief.clickButton('决策对比');
    expect(ready.mock.calls.at(-1)![0].brief.questionsToAnswer).toEqual(['核对性能与成本']);
  });

  it('debounces both endpoints and propagates the latest topicHint even when only the hint changes', async () => {
    const { brief, requests } = setup();
    await vi.advanceTimersByTimeAsync(150);
    const topicHint = '33333333-3333-4333-8333-333333333333';
    brief.update({ topicHint });
    await vi.advanceTimersByTimeAsync(150);
    expect(requests).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(150);
    expect(requests).toHaveLength(2);
    const context = requests.find((request) => request.url.startsWith('/api/ai-research/context'))!;
    expect(new URL(context.url, 'http://test').searchParams.get('topicHint')).toBe(topicHint);
    expect(new URL(context.url, 'http://test').searchParams.has('semantic')).toBe(false);
    expect(JSON.parse(requests.find((request) => request.url.endsWith('/plan'))!.init!.body as string))
      .toMatchObject({ topicHint, question: 'GraphRAG retrieval costs' });
  });

  it('ignores out-of-order context and plan API responses after a new question', async () => {
    const { brief, requests, ready } = setup();
    await vi.advanceTimersByTimeAsync(300);
    const oldRequests = [...requests];
    const question = 'OpenSearch migration risks';
    brief.update({ question });
    await vi.advanceTimersByTimeAsync(300);
    expect(oldRequests.every((request) => request.init?.signal?.aborted)).toBe(true);
    for (const request of requests.slice(2)) {
      respond(request, request.url.endsWith('/plan') ? planResponse(question) : { items: [knowledge] });
    }
    await vi.advanceTimersByTimeAsync(0);
    brief.flush();
    const calls = ready.mock.calls.length;
    for (const request of oldRequests) {
      respond(request, request.url.endsWith('/plan')
        ? planResponse('STALE QUESTION', [{ ...knowledge, id: 'stale', title: 'STALE ITEM' }])
        : { items: [{ ...knowledge, id: 'stale', title: 'STALE ITEM' }] });
    }
    await vi.advanceTimersByTimeAsync(0);
    brief.flush();
    expect(ready).toHaveBeenCalledTimes(calls);
    expect(ready.mock.calls.at(-1)![0].brief.question).toBe(question);
    expect(brief.suggestions().items.map((item) => item.id)).toEqual(['confirmed-1']);
    expect(brief.suggestions().selectedIds).toEqual([]);
  });

  it('publishes the latest explicit selection when a pending plan refresh resolves', async () => {
    const { brief, requests, ready } = setup();
    await vi.advanceTimersByTimeAsync(300);
    for (const request of requests) {
      respond(request, request.url.endsWith('/plan')
        ? planResponse('GraphRAG retrieval costs', [knowledge])
        : { items: [knowledge] });
    }
    await vi.advanceTimersByTimeAsync(0);
    brief.flush();
    brief.suggestions().onToggle(knowledge.id);
    brief.flush();
    brief.update({ question: 'GraphRAG alternative evaluation' });
    await vi.advanceTimersByTimeAsync(300);
    expect(brief.suggestions().selectedIds).toEqual([knowledge.id]);
    const replacement = { ...knowledge, kind: 'research' as const, id: 'research-2', title: 'New source',
      sourceRefs: [{ type: 'research' as const, value: 'research-2', required: false }] };
    respond(requests.slice(2).find((request) => request.url.includes('/context?'))!, { items: [replacement] });
    await vi.advanceTimersByTimeAsync(0);
    brief.flush();
    brief.suggestions().onToggle(knowledge.id);
    brief.flush();
    brief.suggestions().onToggle(replacement.id);
    brief.flush();
    respond(requests.slice(2).find((request) => request.url.endsWith('/plan'))!,
      planResponse('GraphRAG alternative evaluation', [knowledge]));
    await vi.advanceTimersByTimeAsync(0);
    brief.flush();
    expect(brief.suggestions().selectedIds).toEqual([replacement.id]);
    expect(ready.mock.calls.at(-1)![0]).toMatchObject({
      suggestedContextIds: [replacement.id],
      brief: { contextRefs: [{ type: 'research', value: replacement.id, required: false }] },
    });
  });
});
