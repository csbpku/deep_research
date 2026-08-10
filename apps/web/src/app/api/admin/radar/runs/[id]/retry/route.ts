// Admin 来源级重跑：转发到 ai-engine 的 source-scoped retry endpoint。

import type { NextRequest } from 'next/server';
import { apiHandler } from '@/lib/api-handler';
import { forwardAdminRadarAction } from '@/lib/admin-radar-action';

export const POST = apiHandler<[NextRequest, { params: Promise<{ id: string }> }]>(
  async (req, ctx) => {
    const id = (await ctx.params).id;
    return forwardAdminRadarAction(
      req,
      `/api/radar/sync/${encodeURIComponent(id)}/retry`,
      {},
    );
  },
);
