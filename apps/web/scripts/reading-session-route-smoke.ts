/**
 * Real PostgreSQL smoke test for the optional browser-reader session sync.
 * Run against an isolated DATABASE_URL after migrations; it never uses the
 * production database and removes the temporary users before exiting.
 */
import { randomUUID } from 'node:crypto';

async function main() {
  // Keep imports inside the async entrypoint: the web app is compiled as CJS
  // by tsx in this smoke-test context, where top-level await is unavailable.
  const { prisma } = await import('../src/lib/db');
  const { GET, POST } = await import('../src/app/api/reading/session/route');
  const { issueReadingToken, revokeReadingToken } = await import('../src/lib/reading-auth');

  const clientId = randomUUID();
  const user = await prisma.user.create({ data: { email: `reader-session-${randomUUID()}@example.com`, name: 'Reader Session Smoke' } });
  const otherUser = await prisma.user.create({ data: { email: `reader-session-other-${randomUUID()}@example.com`, name: 'Reader Session Other' } });
  const token = issueReadingToken(user.id);
  const otherToken = issueReadingToken(otherUser.id);
  const input = {
    clientId,
    idempotencyKey: randomUUID(),
    document: { url: 'https://example.com/docs', title: 'Docs', version: 'sha256:page-1' },
    state: {
      selection: { quote: 'A paragraph', prefix: '', suffix: '' },
      answer: 'Reusable conclusion',
      discussion: [{ role: 'user', content: 'Why?' }],
      discussionScope: 'selection',
      scrollY: 120,
      scrollHeight: 1600,
    },
  };

  function authRequest(method: string, body?: unknown, bearer = token): Request {
    return new Request('http://localhost/api/reading/session', {
      method,
      headers: { authorization: `Bearer ${bearer}`, ...(body ? { 'content-type': 'application/json' } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
  }

  try {
    const first = await POST(authRequest('POST', input) as never);
    if (first.status !== 200) throw new Error(`first sync failed: ${first.status} ${await first.text()}`);
    const second = await POST(authRequest('POST', input) as never);
    if (second.status !== 200) throw new Error(`retry sync failed: ${second.status} ${await second.text()}`);
    const listed = await GET(authRequest('GET', undefined) as never);
    const listedPayload = await listed.json() as { sessions?: unknown[] };
    if (listed.status !== 200 || listedPayload.sessions?.length !== 1) throw new Error(`expected one idempotent session, got ${JSON.stringify(listedPayload)}`);

    const otherList = await GET(authRequest('GET', undefined, otherToken) as never);
    const otherPayload = await otherList.json() as { sessions?: unknown[] };
    if (otherList.status !== 200 || otherPayload.sessions?.length !== 0) throw new Error(`user isolation failed: ${JSON.stringify(otherPayload)}`);

    if (!await revokeReadingToken(token, user.id)) throw new Error('token revoke failed');
    const revoked = await GET(authRequest('GET') as never);
    if (revoked.status !== 401) throw new Error(`revoked token was accepted: ${revoked.status}`);
    console.log(JSON.stringify({ ok: true, idempotentRows: listedPayload.sessions?.length ?? 0, isolatedRows: otherPayload.sessions?.length ?? 0, revokedStatus: revoked.status }));
  } finally {
    await prisma.readingSession.deleteMany({ where: { userId: { in: [user.id, otherUser.id] } } });
    await prisma.productEvent.deleteMany({ where: { userId: { in: [user.id, otherUser.id] } } });
    await prisma.user.deleteMany({ where: { id: { in: [user.id, otherUser.id] } } });
    await prisma.$disconnect();
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
