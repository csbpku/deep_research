// BFF handler: GET /api/comments/my-stars —— 当前用户对评论的点赞状态。
//
// 用于前端判断"是否已点赞"以切换按钮 UI（无需每次拉全部评论详情）。
// 返回 id 数组（评论 id 列表）。

import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { prisma } from '../../../../lib/db';
import { apiHandler } from '../../../../lib/api-handler';
import { requireUser } from '../../../../lib/auth/session';
import { withRequestId } from '../../../../lib/log';

export const GET = apiHandler<[NextRequest]>(async (req) => {
  const _requestId = withRequestId(req.headers);
  const u = await requireUser(req);
  if (u instanceof NextResponse) return u;

  const stars = await prisma.commentStar.findMany({
    where: { userId: u.id },
    select: { commentId: true },
    take: 500,
  });

  return NextResponse.json({ commentIds: stars.map((s) => s.commentId) });
});