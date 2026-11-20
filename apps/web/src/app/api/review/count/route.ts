import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';

import { apiHandler } from '../../../../lib/api-handler';
import { requireUser } from '../../../../lib/auth/session';
import { prisma } from '../../../../lib/db';
import { getReviewQueueCounts } from '../../../../lib/review-queue-count';

export const dynamic = 'force-dynamic';

// A tiny read used by the shell badge after an action. The server-rendered
// shell cannot know that a judgement was just reaffirmed; this endpoint lets
// the client refresh the count without a full reload.
export const GET = apiHandler<[NextRequest]>(async (req) => {
  const user = await requireUser(req);
  if (user instanceof NextResponse) return user;
  return NextResponse.json(await getReviewQueueCounts(prisma, user.id));
});
