import { createHash } from 'node:crypto';
import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';

import { ReadingSessionStateSchema, ReadingSessionSyncInputSchema } from '@deep-research/shared/schemas';
import { apiHandler, parseBody } from '../../../../lib/api-handler';
import { prisma } from '../../../../lib/db';
import { withRequestId } from '../../../../lib/log';
import { requireReadingUser } from '../../../../lib/reading-auth';

export const dynamic = 'force-dynamic';

function documentKey(url: string, version?: string | null): string {
  return createHash('sha256')
    .update(JSON.stringify({ url, version: version || null }), 'utf8')
    .digest('hex');
}

function shapeSession(row: {
  clientId: string;
  documentUrl: string;
  title: string;
  documentVersion: string | null;
  state: unknown;
  updatedAt: Date;
}) {
  const parsedState = ReadingSessionStateSchema.safeParse(row.state);
  return {
    clientId: row.clientId,
    document: { url: row.documentUrl, title: row.title, version: row.documentVersion },
    state: parsedState.success ? parsedState.data : ReadingSessionStateSchema.parse({}),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export const POST = apiHandler<[NextRequest]>(async (req) => {
  const requestId = withRequestId(req.headers);
  const user = await requireReadingUser(req);
  if (user instanceof Response) return user;
  const input = await parseBody(req, ReadingSessionSyncInputSchema);
  if (input instanceof NextResponse) return input;

  const key = documentKey(input.document.url, input.document.version);
  const row = await prisma.readingSession.upsert({
    where: {
      userId_clientId_documentKey: {
        userId: user.id,
        clientId: input.clientId,
        documentKey: key,
      },
    },
    create: {
      userId: user.id,
      clientId: input.clientId,
      documentKey: key,
      documentUrl: input.document.url,
      title: input.document.title,
      documentVersion: input.document.version || null,
      state: input.state,
      lastSyncKey: input.idempotencyKey,
    },
    update: {
      title: input.document.title,
      documentUrl: input.document.url,
      documentVersion: input.document.version || null,
      state: input.state,
      lastSyncKey: input.idempotencyKey,
    },
    select: {
      clientId: true,
      documentUrl: true,
      title: true,
      documentVersion: true,
      state: true,
      updatedAt: true,
    },
  });
  return NextResponse.json({ ok: true, session: shapeSession(row), requestId });
});

export const GET = apiHandler<[NextRequest]>(async (req) => {
  const requestId = withRequestId(req.headers);
  const user = await requireReadingUser(req);
  if (user instanceof Response) return user;
  const clientId = new URL(req.url).searchParams.get('clientId') || undefined;
  const rows = await prisma.readingSession.findMany({
    where: { userId: user.id, ...(clientId ? { clientId } : {}) },
    orderBy: { updatedAt: 'desc' },
    take: 50,
    select: {
      clientId: true,
      documentUrl: true,
      title: true,
      documentVersion: true,
      state: true,
      updatedAt: true,
    },
  });
  return NextResponse.json({ ok: true, sessions: rows.map(shapeSession), requestId });
});
