export type ResearchConversationPhase = 'understand' | 'refine' | 'ready';

export interface ResearchConversationState {
  topic: string;
  context: string;
  phase: ResearchConversationPhase;
}

export interface ResearchConversationTurn {
  next: ResearchConversationState;
  reply: string;
  canStart: boolean;
}

const SKIP_RESPONSES = new Set(['无', '没有', '暂无', '跳过', '不需要']);
const START_RESPONSES = new Set(['开始', '开始调研', '直接开始', '提交', '启动调研']);

function compact(value: string, maxLength: number): string {
  return value.trim().replace(/\s+/gu, ' ').slice(0, maxLength);
}

function isSkipResponse(value: string): boolean {
  return SKIP_RESPONSES.has(compact(value, 20));
}

export function isStartResearchIntent(value: string): boolean {
  return START_RESPONSES.has(compact(value, 20));
}

export function isResearchQuestionSpecific(value: string): boolean {
  if (isSkipResponse(value) || isStartResearchIntent(value)) return false;
  let subject = compact(value, 200);
  // Remove request scaffolding, not product names: a named object need not
  // contain a research keyword or satisfy an arbitrary sentence length.
  const prefix = /^(?:请|麻烦|能不能|可以|你能|帮我|给我|我想|我要|我希望|想要|想|调研对象(?:就是|是)|研究对象(?:就是|是)|学习|了解|认识|研究|调研|一下|一些|个|关于)\s*/u;
  while (prefix.test(subject)) subject = subject.replace(prefix, '');
  subject = subject.replace(/[啊呀吧吗呢。！!？?\s]+$/gu, '');
  return /[\p{L}\p{N}]{2}/u.test(subject.replace(/\s+/gu, ''))
    && !/^(?:(?:这个|那个|这些|那些|某个)?(?:技术|系统|工具|问题|东西|内容|相关资料|资料)?|它|什么|一下|一些|帮忙|帮个忙)$/u.test(subject);
}

function topicLabel(topic: string): string {
  const text = compact(topic, 48);
  return text.length < compact(topic, 200).length ? `${text}…` : text;
}

export function advanceResearchConversation(
  state: ResearchConversationState,
  userInput: string,
): ResearchConversationTurn {
  const value = compact(userInput, 2_000);
  const currentTopic = compact(state.topic, 200);
  const currentContext = compact(state.context, 2_000);

  if (!currentTopic || state.phase === 'understand') {
    if (!isResearchQuestionSpecific(value)) {
      return {
        next: { ...state, phase: 'understand' },
        reply: '我还没能确定具体的调研对象。请补充要研究的技术、系统或决策问题；例如“我们是否应从 Elasticsearch 迁移到 OpenSearch？”。',
        canStart: false,
      };
    }

    return {
      next: { topic: value.slice(0, 200), context: currentContext, phase: 'ready' },
      reply: /(学习|了解|入门|认识)/u.test(value)
        ? `我会围绕「${topicLabel(value)}」整理概念、主要用途、工作原理和入门路径。可以直接开始；如果这个名称对应多个项目，可补充官网或项目链接以限定范围。`
        : `研究主题已明确为「${topicLabel(value)}」。可以直接开始，也可以补充关注的问题、现有背景或约束。`,
      canStart: true,
    };
  }

  if (isSkipResponse(value)) {
    return {
      next: { topic: currentTopic, context: currentContext, phase: 'ready' },
      reply: '好的，我会以当前问题为主线展开调研。你可以直接开始，也可以在下方确认研究方式、资料来源和交付形式。',
      canStart: true,
    };
  }

  if (state.phase === 'refine') {
    const nextContext = currentContext
      ? `${currentContext}\n${value}`.slice(0, 2_000)
      : value;
    return {
      next: { topic: currentTopic, context: nextContext, phase: 'ready' },
      reply: '这些背景已纳入研究计划。请检查下方的研究方式、资料来源和交付形式；准备好后即可开始。',
      canStart: true,
    };
  }

  const nextContext = currentContext
    ? `${currentContext}\n${value}`.slice(0, 2_000)
    : value;
  return {
    next: { topic: currentTopic, context: nextContext, phase: 'ready' },
    reply: '已补充到研究计划。你可以继续补充要求，或直接开始调研。',
    canStart: true,
  };
}
