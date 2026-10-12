import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { z } from 'zod';

import { apiHandler } from '@/lib/api-handler';
import { requireAdmin } from '@/lib/auth/session';
import { getWebEnv } from '@/lib/env';

const requestSchema = z.object({
  mode: z.enum(['preview', 'report', 'apply', 'rollback', 'recover']),
  batchId: z.string().uuid().optional(),
  limit: z.number().int().min(1).max(100).default(10),
}).strict().refine((v) => v.mode === 'preview' || !!v.batchId, 'batchId is required');

export const POST = apiHandler<[NextRequest]>(async (req) => {
  const admin = await requireAdmin(req);
  if (admin instanceof NextResponse) return admin;
  const body = requestSchema.safeParse(await req.json().catch(() => null));
  if (!body.success) return NextResponse.json({ code: 'VALIDATION_FAILED' }, { status: 400 });
  const env = getWebEnv();
  try {
    const response = await fetch(`${env.AI_ENGINE_URL.replace(/\/$/u, '')}/api/radar/governance`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-internal-token': env.INTERNAL_SERVICE_TOKEN ?? '' },
      body: JSON.stringify({ ...body.data, actorId: admin.id }),
      signal: AbortSignal.timeout(body.data.mode === 'recover' ? 180_000 : 90_000),
      cache: 'no-store',
    });
    return new NextResponse(await response.text(), {
      status: response.status, headers: { 'content-type': 'application/json' },
    });
  } catch {
    return NextResponse.json({ code: 'AI_ENGINE_UNAVAILABLE' }, { status: 503 });
  }
});
