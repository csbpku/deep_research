import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  transaction: vi.fn(),
  lock: vi.fn(),
  findLast: vi.fn(),
  create: vi.fn(),
}));
vi.mock('@/lib/db', () => ({ prisma: { $transaction: mocks.transaction } }));

import { appendResearchMessages, orderedResearchMessages } from './ai-research-message-store';

beforeEach(() => {
  vi.resetAllMocks();
  mocks.transaction.mockImplementation(async (run) => run({
    aiResearchConversation: { update: mocks.lock },
    aiResearchConversationMessage: { findFirst: mocks.findLast, create: mocks.create },
  }));
  mocks.create.mockImplementation(async ({ data }) => data);
});

describe('research transcript ordering', () => {
  it('keeps the greeting, user and reply in order even within one millisecond', () => {
    const rows = orderedResearchMessages([
      { role: 'assistant', content: 'Welcome' },
      { role: 'user', content: 'Grok Bot' },
      { role: 'assistant', content: 'Ready' },
    ], undefined, 1000);
    expect(rows.map((row) => row.createdAt.getTime())).toEqual([1000, 1001, 1002]);
  });

  it('allocates timestamps after the last batch even if the clock moved backwards', async () => {
    const latest = new Date(Date.now() + 10_000);
    mocks.findLast.mockResolvedValue({ createdAt: latest });
    const rows = await appendResearchMessages('conversation', [
      { role: 'user', content: 'Follow up' },
      { role: 'assistant', content: 'Reply', intent: 'verify' },
    ]);
    expect(rows.map((row) => row.createdAt.getTime())).toEqual([
      latest.getTime() + 1, latest.getTime() + 2,
    ]);
    expect(mocks.lock).toHaveBeenCalledWith({
      where: { id: 'conversation' }, data: { updatedAt: expect.any(Date) }, select: { id: true },
    });
    expect(mocks.lock.mock.invocationCallOrder[0]).toBeLessThan(mocks.findLast.mock.invocationCallOrder[0]!);
    expect(mocks.findLast.mock.invocationCallOrder[0]).toBeLessThan(mocks.create.mock.invocationCallOrder[0]!);
    expect(mocks.create).toHaveBeenNthCalledWith(2, {
      data: expect.objectContaining({ conversationId: 'conversation', intent: 'verify' }),
    });
  });
});
