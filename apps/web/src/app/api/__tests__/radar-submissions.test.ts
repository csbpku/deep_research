import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  requireUser: vi.fn(),
  findFirst: vi.fn(),
  create: vi.fn(),
  enqueue: vi.fn(),
}));

vi.mock('../../../lib/api-handler.js', async (importOriginal) => ({
  ...await importOriginal<typeof import('../../../lib/api-handler.js')>(),
  apiHandler: (handler: unknown) => handler,
}));

vi.mock('../../../lib/auth/session.js', () => ({
  requireUser: mocks.requireUser,
}));

vi.mock('../../../lib/db.js', () => ({
  prisma: {
    radarSubmission: {
      findFirst: mocks.findFirst,
      create: mocks.create,
    },
  },
}));

vi.mock('../../../lib/radar/submissions/worker-bridge.js', () => ({
  enqueueRadarSubmission: mocks.enqueue,
}));

import { POST } from '../radar/submissions/route';

const USER = {
  id: '11111111-1111-1111-1111-111111111111',
  email: 'member@example.com',
  name: 'Member',
  image: null,
  role: 'member' as const,
  disabledAt: null,
};

function request(body: unknown): Request {
  return new Request('http://localhost/api/radar/submissions', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-request-id': 'test-request-id',
    },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.requireUser.mockResolvedValue(USER);
  mocks.findFirst.mockResolvedValue(null);
  mocks.enqueue.mockResolvedValue(undefined);
  mocks.create.mockResolvedValue({
    id: '22222222-2222-4222-8222-222222222222',
    status: 'type_detected',
    detectedKind: 'github_repo',
    rawInput: 'https://github.com/openai/codex',
    canonicalUrl: 'https://github.com/openai/codex',
    contentSha256: null,
    summaryId: null,
    errorCode: null,
    errorMessage: null,
    createdAt: new Date('2026-08-04T10:00:00.000Z'),
    completedAt: null,
  });
});

describe('POST /api/radar/submissions', () => {
  it('canonicalizes, persists, and enqueues a valid URL', async () => {
    const accepted = await POST(request({
      rawInput: ' https://github.com/openai/codex/?utm_source=audit#readme ',
    }) as never);

    expect(accepted.status).toBe(202);
    expect(mocks.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        submitterId: USER.id,
        kind: 'github_repo',
        canonicalUrl: 'https://github.com/openai/codex',
        status: 'type_detected',
      }),
    }));
    expect(mocks.enqueue).toHaveBeenCalledWith('22222222-2222-4222-8222-222222222222');
  });

  it('rejects loopback and non-http input before touching the database', async () => {
    const loopback = await POST(request({ rawInput: 'http://127.0.0.1/private' }) as never);
    const invalid = await POST(request({ rawInput: 'not a url' }) as never);

    expect(loopback.status).toBe(400);
    expect((await loopback.json()).code).toBe('URL_FETCH_BLOCKED');
    expect(invalid.status).toBe(400);
    expect(mocks.create).not.toHaveBeenCalled();
  });

  it('returns the active submission instead of creating a duplicate', async () => {
    mocks.findFirst.mockResolvedValueOnce({ id: 'existing-id', status: 'extracting' });

    const response = await POST(request({ rawInput: 'https://example.com/post' }) as never);

    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({
      code: 'RADAR_SUBMISSION_DUPLICATE_ACTIVE',
      submissionId: 'existing-id',
      status: 'extracting',
    });
    expect(mocks.create).not.toHaveBeenCalled();
  });
});
