/**
 * Real PostgreSQL smoke test for browser-reader knowledge saves.
 * Run against an isolated DATABASE_URL after migrations. Temporary rows are
 * removed before exit.
 */
import { randomUUID } from 'node:crypto';

async function main() {
  const { prisma } = await import('../src/lib/db');
  const { POST } = await import('../src/app/api/reading/save/route');
  const { issueReadingToken } = await import('../src/lib/reading-auth');

  const user = await prisma.user.create({
    data: { email: `reader-save-${randomUUID()}@example.com`, name: 'Reader Save Smoke' },
  });
  const otherUser = await prisma.user.create({
    data: { email: `reader-save-other-${randomUUID()}@example.com`, name: 'Reader Save Other' },
  });
  const token = issueReadingToken(user.id);
  const otherToken = issueReadingToken(otherUser.id);
  const idempotencyKey = randomUUID();
  const input = {
    idempotencyKey,
    url: 'https://example.com/technical-reader',
    title: 'Technical Reader Acceptance',
    quote: 'Bounded evidence should remain attached to the original technical article.',
    note: 'Keep this as a reusable engineering conclusion.',
    aiAnswer: 'The conclusion is useful only while its stated evidence and limits remain visible.',
    tags: ['browser-reading', 'acceptance'],
  };

  function request(bearer: string): Request {
    return new Request('http://localhost/api/reading/save', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${bearer}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify(input),
    });
  }

  try {
    const first = await POST(request(token) as never);
    const firstPayload = await first.json() as { draft?: { id?: string }; deduplicated?: boolean };
    if (first.status !== 201 || !firstPayload.draft?.id || firstPayload.deduplicated) {
      throw new Error(`first save failed: ${first.status} ${JSON.stringify(firstPayload)}`);
    }

    const retry = await POST(request(token) as never);
    const retryPayload = await retry.json() as { draft?: { id?: string }; deduplicated?: boolean };
    if (
      retry.status !== 200
      || retryPayload.draft?.id !== firstPayload.draft.id
      || !retryPayload.deduplicated
    ) {
      throw new Error(`idempotent retry failed: ${retry.status} ${JSON.stringify(retryPayload)}`);
    }

    const other = await POST(request(otherToken) as never);
    const otherPayload = await other.json() as { draft?: { id?: string }; deduplicated?: boolean };
    if (
      other.status !== 201
      || !otherPayload.draft?.id
      || otherPayload.draft.id === firstPayload.draft.id
      || otherPayload.deduplicated
    ) {
      throw new Error(`user isolation failed: ${other.status} ${JSON.stringify(otherPayload)}`);
    }

    const rows = await prisma.research.findMany({
      where: { readingSaveKey: idempotencyKey },
      select: {
        id: true,
        authorId: true,
        status: true,
        researchSources: { select: { canonicalKey: true } },
        audit: { select: { action: true } },
      },
      orderBy: { createdAt: 'asc' },
    });
    if (
      rows.length !== 2
      || new Set(rows.map((row) => row.authorId)).size !== 2
      || rows.some((row) => row.status !== 'draft')
      || rows.some((row) => row.researchSources.length !== 1)
      || rows.some((row) => row.researchSources[0]?.canonicalKey !== input.url)
      || rows.some((row) => row.audit.length !== 1 || row.audit[0]?.action !== 'create')
    ) {
      throw new Error(`database assertions failed: ${JSON.stringify(rows)}`);
    }

    console.log(JSON.stringify({
      ok: true,
      drafts: rows.length,
      sourcesPerDraft: rows.map((row) => row.researchSources.length),
      auditsPerDraft: rows.map((row) => row.audit.length),
      retryReusedDraft: retryPayload.draft.id === firstPayload.draft.id,
      usersIsolated: rows[0]?.authorId !== rows[1]?.authorId,
    }));
  } finally {
    await prisma.research.deleteMany({
      where: { authorId: { in: [user.id, otherUser.id] }, readingSaveKey: idempotencyKey },
    });
    await prisma.productEvent.deleteMany({ where: { userId: { in: [user.id, otherUser.id] } } });
    await prisma.user.deleteMany({ where: { id: { in: [user.id, otherUser.id] } } });
    await prisma.$disconnect();
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
