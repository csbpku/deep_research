import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  requireUser: vi.fn(),
  templateFindUnique: vi.fn(),
  researchCreate: vi.fn(),
  templateUpdate: vi.fn(),
  transaction: vi.fn(),
}));

vi.mock('../../../lib/api-handler.js', async (importOriginal) => ({
  ...await importOriginal<typeof import('../../../lib/api-handler.js')>(),
  apiHandler: (handler: unknown) => handler,
}));
vi.mock('../../../lib/auth/session.js', () => ({ requireUser: mocks.requireUser }));
vi.mock('../../../lib/db.js', () => ({
  prisma: {
    researchTemplate: { findUnique: mocks.templateFindUnique },
    $transaction: mocks.transaction,
  },
}));

import { POST } from '../me/templates/[id]/apply/route';

const USER_ID = '11111111-1111-4111-8111-111111111111';
const TEMPLATE_ID = '22222222-2222-4222-8222-222222222222';

beforeEach(() => {
  vi.clearAllMocks();
  mocks.requireUser.mockResolvedValue({ id: USER_ID, role: 'member' });
  mocks.templateFindUnique.mockResolvedValue({
    id: TEMPLATE_ID,
    ownerId: USER_ID,
    title: '我的模板名称',
    topic: '评估 React Server Components 的生产风险',
    background: '用于架构选型',
    tags: ['react'],
  });
  mocks.researchCreate.mockResolvedValue({ id: 'draft-id', title: '评估 React Server Components 的生产风险' });
  mocks.templateUpdate.mockResolvedValue({});
  mocks.transaction.mockImplementation((callback) => callback({
    research: { create: mocks.researchCreate },
    researchTemplate: { update: mocks.templateUpdate },
  }));
});

describe('POST /api/me/templates/[id]/apply', () => {
  it('uses the research topic as the draft title instead of the template library name', async () => {
    const response = await POST(
      new Request(`http://localhost/api/me/templates/${TEMPLATE_ID}/apply`, { method: 'POST' }) as never,
      { params: Promise.resolve({ id: TEMPLATE_ID }) },
    );

    expect(response.status).toBe(201);
    expect(mocks.researchCreate).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        title: '评估 React Server Components 的生产风险',
        background: '用于架构选型',
      }),
    }));
  });
});
