import { beforeEach, describe, expect, it, vi } from 'vitest';

const USER_ID = '11111111-1111-4111-8111-111111111111';
const JOB_ID = '22222222-2222-4222-8222-222222222222';

const mocks = vi.hoisted(() => ({
  requireUser: vi.fn(),
  jobFindUnique: vi.fn(),
  fetchAiEngine: vi.fn(),
}));

vi.mock('@/lib/api-handler', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/api-handler')>()),
  apiHandler: (handler: unknown) => handler,
}));
vi.mock('@/lib/auth/session', () => ({ requireUser: mocks.requireUser }));
vi.mock('@/lib/db', () => ({ prisma: { aiResearchJob: { findUnique: mocks.jobFindUnique } } }));
vi.mock('@/lib/env', () => ({ getWebEnv: () => ({ AI_ENGINE_URL: 'http://ai.test' }) }));
vi.mock('@/lib/ai-bff/fetch-ai-engine', () => ({ fetchAiEngine: mocks.fetchAiEngine }));

import { POST } from '../[jobId]/cancel/route';

function request() {
  return new Request(`http://localhost/api/ai-research/${JOB_ID}/cancel`, { method: 'POST' }) as never;
}

beforeEach(() => {
  vi.resetAllMocks();
  mocks.requireUser.mockResolvedValue({ id: USER_ID, role: 'member' });
});

describe('POST /api/ai-research/[jobId]/cancel', () => {
  it('hides a job owned by another user', async () => {
    mocks.jobFindUnique.mockResolvedValue({ requesterId: 'someone-else' });
    const response = await POST(request(), { params: Promise.resolve({ jobId: JOB_ID }) });
    expect(response.status).toBe(404);
    expect(mocks.fetchAiEngine).not.toHaveBeenCalled();
  });

  it('cancels the owned job through ai-engine without retrying', async () => {
    mocks.jobFindUnique.mockResolvedValue({ requesterId: USER_ID });
    mocks.fetchAiEngine.mockResolvedValue({
      ok: true,
      status: 200,
      body: { job_id: JOB_ID, was_queued: false, was_running: true },
    });
    const response = await POST(request(), { params: Promise.resolve({ jobId: JOB_ID }) });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ jobId: JOB_ID, wasQueued: false, wasRunning: true });
    expect(mocks.fetchAiEngine).toHaveBeenCalledWith(expect.objectContaining({
      method: 'POST',
      retry: false,
      url: `http://ai.test/api/ai/jobs/${JOB_ID}/cancel`,
    }));
  });
});
