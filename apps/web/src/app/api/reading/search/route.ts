import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { ReadingSearchInputSchema } from '@deep-research/shared/schemas';
import { apiHandler, parseBody } from '../../../../lib/api-handler';
import { requireReadingUser } from '../../../../lib/reading-auth';
import { fetchAiEngine } from '../../../../lib/ai-bff/fetch-ai-engine';
import { getWebEnv } from '../../../../lib/env';
import { withRequestId } from '../../../../lib/log';
import { toApiErrorResponse } from '../../../../lib/errors';

export const POST = apiHandler<[NextRequest]>(async req => {
  const user = await requireReadingUser(req);
  if (user instanceof Response) return user;
  const input = await parseBody(req, ReadingSearchInputSchema);
  if (input instanceof NextResponse) return input;
  const requestId = withRequestId(req.headers);
  const result = await fetchAiEngine<Record<string, unknown>>({
    url: `${getWebEnv().AI_ENGINE_URL.replace(/\/$/u, '')}/api/ai/reading/search`,
    method: 'POST', timeoutMs: 25_000, retry: false, signal: req.signal,
    requestId, context: 'reading.search',
    body: { ...input, requester_id: user.id },
  });
  if (!result.ok) return toApiErrorResponse({ code: result.code || 'AI_ENGINE_UNAVAILABLE', message: result.message, requestId });
  return NextResponse.json(result.body);
});
