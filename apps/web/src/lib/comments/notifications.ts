import type { Prisma } from '@prisma/client';

export async function createCommentMentionsAndNotifications({
  tx,
  commentId,
  body,
  actorId,
  mentionedUserIds,
  parentAuthorId,
}: {
  tx: Prisma.TransactionClient;
  commentId: string;
  body: string;
  actorId: string;
  mentionedUserIds: string[];
  parentAuthorId?: string | null;
}) {
  const requestedIds = [...new Set(mentionedUserIds)].filter((id) => id !== actorId);
  const mentionableUsers = requestedIds.length > 0
    ? await tx.user.findMany({
        where: { id: { in: requestedIds }, disabledAt: null },
        select: { id: true, name: true },
      })
    : [];
  const validMentionIds = mentionableUsers
    .filter((user) => body.includes(`@${user.name}`))
    .map((user) => user.id);

  if (validMentionIds.length > 0) {
    await tx.commentMention.createMany({
      data: validMentionIds.map((userId) => ({ commentId, userId })),
      skipDuplicates: true,
    });
  }

  const replyRecipientId = parentAuthorId && parentAuthorId !== actorId ? parentAuthorId : null;
  const notifications = [
    ...(replyRecipientId
      ? [{ recipientId: replyRecipientId, actorId, sourceCommentId: commentId, type: 'reply' as const }]
      : []),
    ...validMentionIds
      .filter((recipientId) => recipientId !== replyRecipientId)
      .map((recipientId) => ({
        recipientId,
        actorId,
        sourceCommentId: commentId,
        type: 'mention' as const,
      })),
  ];

  if (notifications.length > 0) {
    await tx.notification.createMany({ data: notifications, skipDuplicates: true });
  }

  return validMentionIds;
}
