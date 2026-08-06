import { describe, expect, it, vi } from 'vitest';

vi.mock('../../../lib/api-handler.js', async (importOriginal) => ({
  ...await importOriginal<typeof import('../../../lib/api-handler.js')>(),
  apiHandler: (handler: unknown) => handler,
}));
vi.mock('../../../lib/auth/session.js', () => ({
  requireUser: vi.fn().mockResolvedValue({
    id: '11111111-1111-4111-8111-111111111111',
    role: 'member',
  }),
}));

import { POST as createMessage } from '../chat/sessions/[id]/messages/route';

const SESSION_ID = '22222222-2222-4222-8222-222222222222';

describe('POST /api/chat/sessions/[id]/messages validation', () => {
  it('reports the question length limit instead of a generic error', async () => {
    const response = await createMessage(
      new Request(`http://localhost/api/chat/sessions/${SESSION_ID}/messages`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ content: 'x'.repeat(4001) }),
      }) as never,
      { params: Promise.resolve({ id: SESSION_ID }) },
    );
    const payload = await response.json();

    expect(response.status).toBe(400);
    expect(payload.message).toBe('请检查必填项和输入格式');
    expect(payload.details.fieldErrors.content[0]).toBe('提问最多 4000 字');
  });
});
