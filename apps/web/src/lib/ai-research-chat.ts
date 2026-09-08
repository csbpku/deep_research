// AI 调研持久化对话的类型与共享工具。
// 规划阶段的问答由前端确定性状态机生成，BFF 只负责落库；
// 任务完成后的追问由 ai-engine 生成并流式返回，BFF 负责透传 + 落库。

export type FollowUpIntent = 'answer' | 'verify' | 'revise' | 'action';

export interface AiResearchChatMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  createdAt: string;
  intent?: FollowUpIntent;
}

export interface AiResearchConversationSummary {
  id: string;
  jobId: string | null;
  title: string;
  status: string;
  messageCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface AiResearchConversationDetail extends AiResearchConversationSummary {
  messages: AiResearchChatMessage[];
}

export function publicAiResearchMessage(message: {
  id: string;
  role: string;
  content: string;
  intent?: string | null;
  createdAt: Date;
}): AiResearchChatMessage {
  const intent: FollowUpIntent | undefined = message.intent === 'verify' || message.intent === 'revise' || message.intent === 'action'
    ? message.intent
    : message.intent === 'answer'
      ? 'answer'
      : undefined;
  return {
    id: message.id,
    role: message.role === 'assistant' ? 'assistant' : 'user',
    content: message.content,
    createdAt: message.createdAt.toISOString(),
    ...(intent ? { intent } : {}),
  };
}
