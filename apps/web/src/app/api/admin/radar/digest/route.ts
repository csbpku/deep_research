import type { NextRequest } from 'next/server';

import { apiHandler } from '@/lib/api-handler';
import { forwardAdminRadarAction } from '@/lib/admin-radar-action';

export const POST = apiHandler<[NextRequest]>(async (req) =>
  forwardAdminRadarAction(req, '/api/radar/digest/regenerate', {}),
);
