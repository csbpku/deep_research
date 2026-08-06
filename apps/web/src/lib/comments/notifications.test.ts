import { describe, expect, it, vi } from 'vitest';

import { createCommentMentionsAndNotifications } from './notifications';

describe('createCommentMentionsAndNotifications', () => {
  it('records valid mentions and avoids duplicating a reply as a mention notification', async () => {
    const tx = {
      user: { findMany: vi.fn().mockResolvedValue([{ id: 'member-a', name: '成员 A' }, { id: 'parent', name: '回复对象' }]) },
      commentMention: { createMany: vi.fn().mockResolvedValue({ count: 2 }) },
      notification: { createMany: vi.fn().mockResolvedValue({ count: 2 }) },
    };

    await createCommentMentionsAndNotifications({
      tx: tx as never,
      commentId: 'comment-1',
      body: '@成员 A @回复对象 请一起看看',
      actorId: 'author',
      mentionedUserIds: ['member-a', 'parent', 'member-a', 'author'],
      parentAuthorId: 'parent',
    });

    expect(tx.user.findMany).toHaveBeenCalledWith({
      where: { id: { in: ['member-a', 'parent'] }, disabledAt: null },
      select: { id: true, name: true },
    });
    expect(tx.commentMention.createMany).toHaveBeenCalledWith({
      data: [
        { commentId: 'comment-1', userId: 'member-a' },
        { commentId: 'comment-1', userId: 'parent' },
      ],
      skipDuplicates: true,
    });
    expect(tx.notification.createMany).toHaveBeenCalledWith({
      data: [
        { recipientId: 'parent', actorId: 'author', sourceCommentId: 'comment-1', type: 'reply' },
        { recipientId: 'member-a', actorId: 'author', sourceCommentId: 'comment-1', type: 'mention' },
      ],
      skipDuplicates: true,
    });
  });

  it('does not notify when the author only mentions or replies to themselves', async () => {
    const tx = {
      user: { findMany: vi.fn() },
      commentMention: { createMany: vi.fn() },
      notification: { createMany: vi.fn() },
    };

    await createCommentMentionsAndNotifications({
      tx: tx as never,
      commentId: 'comment-2',
      body: '@自己',
      actorId: 'author',
      mentionedUserIds: ['author'],
      parentAuthorId: 'author',
    });

    expect(tx.user.findMany).not.toHaveBeenCalled();
    expect(tx.commentMention.createMany).not.toHaveBeenCalled();
    expect(tx.notification.createMany).not.toHaveBeenCalled();
  });
});
