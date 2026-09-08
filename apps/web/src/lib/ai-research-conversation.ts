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
  const topic = compact(value, 200);
  if (topic.length < 8) return false;

  return /[？?]/u.test(topic)
    || /(研究|调研|是否|怎么|如何|为什么|能否|应不应该|该不该|对比|比较|选型|评估|方案|架构|实现|迁移|优化|风险|成本|性能|技术|系统|平台|模型|框架|数据库|协议|工具)/u.test(topic);
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
      next: { topic: value.slice(0, 200), context: currentContext, phase: 'refine' },
      reply: `我理解你的问题是「${topicLabel(value)}」。这份调研将支持什么决策、受哪些约束影响？例如现有方案、团队规模、预算、上线时间。没有额外背景可以回复“跳过”。`,
      canStart: true,
    };
  }

  if (state.phase === 'refine') {
    if (isSkipResponse(value)) {
      return {
        next: { topic: currentTopic, context: currentContext, phase: 'ready' },
        reply: '好的，我会以当前问题为主线展开调研。你可以直接开始，也可以在下方确认研究方式、资料来源和交付形式。',
        canStart: true,
      };
    }

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
