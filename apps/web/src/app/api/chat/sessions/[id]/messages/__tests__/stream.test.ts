import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  requireUser: vi.fn(),
  fetchChatEngine: vi.fn(),
  streamChatEngine: vi.fn(),
  readUpstreamJson: vi.fn(),
}));

vi.mock('../../../../../../../lib/api-handler.js', async (importOriginal) => ({
  ...await importOriginal<typeof import('../../../../../../../lib/api-handler.js')>(),
  apiHandler: (handler: unknown) => handler,
}));
vi.mock('../../../../../../../lib/auth/session.js', () => ({
  requireUser: mocks.requireUser,
}));
vi.mock('../../../../../../../lib/chat-bff.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../../../../../lib/chat-bff.js')>();
  return {
    ...actual,
    fetchChatEngine: mocks.fetchChatEngine,
    streamChatEngine: mocks.streamChatEngine,
    readUpstreamJson: mocks.readUpstreamJson,
  };
});

import { POST as streamMessage } from '../stream/route';

const SESSION_ID = '22222222-2222-4222-8222-222222222222';
const USER_ID = '11111111-1111-4111-8111-111111111111';

function request(body: unknown) {
  return new Request(
    `http://localhost/api/chat/sessions/${SESSION_ID}/messages/stream`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    },
  ) as never;
}

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function sseResponse(body: string, status = 200) {
  return new Response(body, {
    status,
    headers: { 'content-type': 'text/event-stream' },
  });
}

beforeEach(() => {
  vi.resetAllMocks();
  mocks.requireUser.mockResolvedValue({ id: USER_ID, role: 'member' });
  // Use a fresh Response per call so the body isn't consumed across ownership
  // probe + stream proxy steps.
  mocks.fetchChatEngine.mockImplementation(async () =>
    jsonResponse({
      session_id: SESSION_ID,
      user_id: USER_ID,
      status: 'active',
      seed_snapshot: { id: 'seed', title: 'x', url: 'u', body: 'b', interpretation: null, summary_date: '2026-01-01', tags: [], original_markdown: null, original_kind: null },
    }),
  );
  mocks.readUpstreamJson.mockImplementation(async (res: Response) => JSON.parse(await res.text()));
});

describe('POST /api/chat/sessions/[id]/messages/stream', () => {
  it('rejects an empty question with 400', async () => {
    const res = await streamMessage(request({ content: '' }), { params: Promise.resolve({ id: SESSION_ID }) });
    const payload = await res.json();
    expect(res.status).toBe(400);
    expect(payload.message).toBe('请检查必填项和输入格式');
    expect(mocks.streamChatEngine).not.toHaveBeenCalled();
  });

  it('pipes the upstream SSE body through with text/event-stream content-type', async () => {
    const sseBody = 'event: start\ndata: {"ok": true}\n\n';
    mocks.streamChatEngine.mockResolvedValue(sseResponse(sseBody));
    const res = await streamMessage(request({ content: 'hello' }), { params: Promise.resolve({ id: SESSION_ID }) });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/event-stream');
    expect(res.headers.get('cache-control')).toBe('no-cache, no-transform');
    expect(await res.text()).toBe(sseBody);
  });

  it('returns 404 when the session does not belong to the caller', async () => {
    mocks.readUpstreamJson.mockResolvedValue({
      session_id: SESSION_ID,
      user_id: 'someone-else',
      status: 'active',
      seed_snapshot: {},
    });
    const res = await streamMessage(request({ content: 'hello' }), { params: Promise.resolve({ id: SESSION_ID }) });
    const payload = await res.json();
    expect(res.status).toBe(404);
    expect(payload.code).toBe('AI_CHAT_SESSION_NOT_FOUND');
  });

  it('returns an error when the upstream SSE stream is missing', async () => {
    mocks.streamChatEngine.mockResolvedValue(sseResponse('upstream down', 503));
    const res = await streamMessage(request({ content: 'hello' }), { params: Promise.resolve({ id: SESSION_ID }) });
    const payload = await res.json();
    expect(res.status).toBe(503);
    expect(payload.code).toBe('AI_ENGINE_UNAVAILABLE');
  });
});