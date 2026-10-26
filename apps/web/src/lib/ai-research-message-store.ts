import { prisma } from '@/lib/db';
import type { FollowUpIntent } from '@/lib/ai-research-chat';

interface ConversationMessageInput {
  role: 'user' | 'assistant';
  content: string;
  intent?: FollowUpIntent;
}

export function orderedResearchMessages(
  messages: ConversationMessageInput[],
  previousCreatedAt?: Date,
  now = Date.now(),
) {
  const first = Math.max(now, (previousCreatedAt?.getTime() ?? -1) + 1);
  return messages.map((message, index) => ({
    ...message,
    createdAt: new Date(first + index),
  }));
}

export async function appendResearchMessages(
  conversationId: string,
  messages: ConversationMessageInput[],
) {
  return prisma.$transaction(async (tx) => {
    // Lock the parent before allocating timestamps, including for SSE writes.
    // CURRENT_TIMESTAMP is shared by a batch; random UUIDs cannot order it.
    await tx.aiResearchConversation.update({
      where: { id: conversationId },
      data: { updatedAt: new Date() },
      select: { id: true },
    });
    const last = await tx.aiResearchConversationMessage.findFirst({
      where: { conversationId },
      orderBy: { createdAt: 'desc' },
      select: { createdAt: true },
    });
    const created = [];
    for (const message of orderedResearchMessages(messages, last?.createdAt)) {
      created.push(await tx.aiResearchConversationMessage.create({
        data: { conversationId, ...message },
      }));
    }
    return created;
  });
}
