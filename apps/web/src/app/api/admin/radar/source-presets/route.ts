import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { z } from 'zod';
import { apiHandler, parseBody } from '@/lib/api-handler';
import { requireAdmin } from '@/lib/auth/session';
import { prisma } from '@/lib/db';
import { matchingSources, RADAR_SOURCE_PRESETS } from '@/lib/radar/source-presets';

const bodySchema = z.object({ presetId: z.enum(['simon-willison-entries', 'nvidia-developer-blog']) }).strict();
const selection = { id: true, name: true, enabled: true, autoPausedAt: true, config: true } as const;

export const GET = apiHandler<[NextRequest]>(async (req) => {
  const admin = await requireAdmin(req);
  if (admin instanceof NextResponse) return admin;
  const rows = await prisma.radarSource.findMany({ select: selection });
  return NextResponse.json({ items: RADAR_SOURCE_PRESETS.map((preset) => ({
    id: preset.id, name: preset.name, description: preset.description, feedUrl: preset.feedUrl,
    existing: matchingSources(preset, rows).map(({ id, name, enabled, autoPausedAt }) => ({
      id, name, enabled, autoPaused: autoPausedAt !== null,
    })),
  })) });
});

export const POST = apiHandler<[NextRequest]>(async (req) => {
  const admin = await requireAdmin(req);
  if (admin instanceof NextResponse) return admin;
  const body = await parseBody(req, bodySchema);
  if (body instanceof NextResponse) return body;
  const preset = RADAR_SOURCE_PRESETS.find((entry) => entry.id === body.presetId)!;
  const result = await prisma.$transaction(async (tx) => {
    // Serialize check+insert across all workers, including writes to this table
    // already in flight. No network access or model call occurs under the lock.
    await tx.$executeRaw`LOCK TABLE radar_sources IN SHARE ROW EXCLUSIVE MODE`;
    const existing = matchingSources(preset, await tx.radarSource.findMany({ select: selection }));
    if (existing.length) return { created: false, existing: existing.map(({ id, name, enabled, autoPausedAt }) => ({ id, name, enabled, autoPaused: autoPausedAt !== null })) };
    const source = await tx.radarSource.create({ data: {
      name: preset.name, sourceType: 'rss', enabled: true,
      config: { feedUrl: preset.feedUrl, maxResults: preset.maxResults, maxAgeHours: preset.maxAgeHours, applyAiFilter: preset.applyAiFilter },
    }, select: { id: true, name: true } });
    await tx.adminAction.create({ data: {
      actorId: admin.id, action: 'radar.source_preset_add', targetType: 'radar_source', targetId: source.id,
      requestId: crypto.randomUUID(), metadata: { presetId: preset.id, feedUrl: preset.feedUrl },
    } });
    return { created: true, existing: [{ ...source, enabled: true, autoPaused: false }] };
  });
  return NextResponse.json(result, { status: result.created ? 201 : 200 });
});
