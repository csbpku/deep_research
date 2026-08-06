import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { prisma } from '../../../../../lib/db';
import { apiHandler, parseBody } from '../../../../../lib/api-handler';
import { requireUser } from '../../../../../lib/auth/session';
import { ResearchIdParam } from '../../../../../lib/schemas';

const CitationInput = z.object({
  sourceId: z.string().uuid(), marker: z.string().trim().min(1).max(64),
  quote: z.string().trim().min(1).max(2000), startOffset: z.number().int().min(0),
  endOffset: z.number().int().min(0), contentHash: z.string().regex(/^[a-f0-9]{64}$/u),
});

async function access(id: string, user: { id: string; role: string }) {
  const research = await prisma.research.findUnique({ where: { id }, select: { id: true, status: true, authorId: true, body: true } });
  return research && (research.status === 'published' || research.authorId === user.id || user.role === 'admin') ? research : null;
}

export const GET = apiHandler<[NextRequest, { params: Promise<{ id: string }> }]>(async (req, ctx) => {
  const user = await requireUser(req as Request); if (user instanceof NextResponse) return user;
  const parsed = ResearchIdParam.safeParse(await ctx.params); if (!parsed.success) return NextResponse.json({ message: 'id 无效' }, { status: 400 });
  if (!await access(parsed.data.id, user)) return NextResponse.json({ message: '无权访问' }, { status: 404 });
  const items = await prisma.researchCitation.findMany({ where: { researchId: parsed.data.id }, include: { source: true }, orderBy: { createdAt: 'asc' } });
  return NextResponse.json({ items });
});

export const POST = apiHandler<[NextRequest, { params: Promise<{ id: string }> }]>(async (req, ctx) => {
  const user = await requireUser(req as Request); if (user instanceof NextResponse) return user;
  const parsed = ResearchIdParam.safeParse(await ctx.params); if (!parsed.success) return NextResponse.json({ message: 'id 无效' }, { status: 400 });
  if (!await access(parsed.data.id, user)) return NextResponse.json({ message: '无权访问' }, { status: 404 });
  const body = await parseBody(req, CitationInput); if (body instanceof NextResponse) return body;
  const research = await access(parsed.data.id, user);
  if (!research) return NextResponse.json({ message: '无权访问' }, { status: 404 });
  if (body.endOffset <= body.startOffset || body.endOffset > research.body.length) {
    return NextResponse.json({ message: '引用范围无效' }, { status: 400 });
  }
  if (createHash('sha256').update(research.body).digest('hex') !== body.contentHash || research.body.slice(body.startOffset, body.endOffset).trim() !== body.quote.trim()) {
    return NextResponse.json({ message: '引用位置已变化，请重新选择正文' }, { status: 400 });
  }
  const source = await prisma.researchSource.findFirst({ where: { id: body.sourceId, researchId: parsed.data.id } });
  if (!source) return NextResponse.json({ message: '来源不属于此调研' }, { status: 400 });
  const item = await prisma.researchCitation.upsert({ where: { researchId_marker: { researchId: parsed.data.id, marker: body.marker } }, create: { ...body, researchId: parsed.data.id }, update: body, include: { source: true } });
  return NextResponse.json({ citation: item }, { status: 201 });
});
