import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  requireAdmin: vi.fn(),
  summaryFindUnique: vi.fn(),
  topicFindFirst: vi.fn(),
  topicCandidateUpsert: vi.fn(),
}));

vi.mock('../../../lib/api-handler.js', async (importOriginal) => ({
  ...await importOriginal<typeof import('../../../lib/api-handler.js')>(),
  apiHandler: (handler: unknown) => handler,
}));

vi.mock('../../../lib/auth/session.js', () => ({
  requireAdmin: mocks.requireAdmin,
}));

vi.mock('../../../lib/db.js', () => ({
  prisma: {
    summary: { findUnique: mocks.summaryFindUnique },
    topic: { findFirst: mocks.topicFindFirst },
    topicCandidate: { upsert: mocks.topicCandidateUpsert },
  },
}));

import { POST } from '../radar/[id]/topics/route';

const SUMMARY_ID = '11111111-1111-4111-8111-111111111111';
const TOPIC_ID = '22222222-2222-4222-8222-222222222222';
const ADMIN = {
  id: '33333333-3333-4333-8333-333333333333',
  email: 'admin@example.com',
  name: 'Admin',
  image: null,
  role: 'admin' as const,
  disabledAt: null,
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.requireAdmin.mockResolvedValue(ADMIN);
  mocks.summaryFindUnique.mockResolvedValue({
    id: SUMMARY_ID,
    source: 'daily',
    syncRunId: 'run-1',
    status: 'candidate',
  });
  mocks.topicFindFirst.mockResolvedValue({
    id: TOPIC_ID,
    slug: 'agents',
    name: 'AI Agents',
    tier: 'core',
  });
  mocks.topicCandidateUpsert.mockResolvedValue({});
});

describe('POST /api/radar/[id]/topics', () => {
  it('rejects non-admin users before reading or writing topic data', async () => {
    const { NextResponse } = await import('next/server');
    mocks.requireAdmin.mockResolvedValueOnce(NextResponse.json(
      { code: 'PERMISSION_DENIED', message: '需要管理员权限', requestId: 'r' },
      { status: 403 },
    ));

    const response = await POST(
      new Request(`http://localhost/api/radar/${SUMMARY_ID}/topics`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ topicId: TOPIC_ID }),
      }) as never,
      { params: Promise.resolve({ id: SUMMARY_ID }) },
    );

    expect(response.status).toBe(403);
    expect(mocks.summaryFindUnique).not.toHaveBeenCalled();
    expect(mocks.topicCandidateUpsert).not.toHaveBeenCalled();
  });

  it('allows an admin to create a manual correction', async () => {
    const response = await POST(
      new Request(`http://localhost/api/radar/${SUMMARY_ID}/topics`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ topicId: TOPIC_ID }),
      }) as never,
      { params: Promise.resolve({ id: SUMMARY_ID }) },
    );

    expect(response.status).toBe(201);
    expect(mocks.topicCandidateUpsert).toHaveBeenCalledWith({
      where: { topicId_summaryId: { topicId: TOPIC_ID, summaryId: SUMMARY_ID } },
      create: { topicId: TOPIC_ID, summaryId: SUMMARY_ID, addedReason: 'admin_manual' },
      update: { addedReason: 'admin_manual' },
    });
  });
});
