import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

// Explicitly isolated local database only; never point this at a development DB.
const dbUrl = process.env.SOURCE_PRESET_TEST_DATABASE_URL;
const allowed = (() => {
  if (!dbUrl || process.env.DATABASE_URL !== dbUrl) return false;
  try { const url = new URL(dbUrl); return url.hostname === '127.0.0.1' && url.pathname === '/deep_research_radar_evidence_test'; } catch { return false; }
})();
const actor = vi.hoisted(() => ({ id: '' }));
vi.mock('@/lib/auth/session', () => ({ requireAdmin: async () => ({ id: actor.id }) }));
let prisma: typeof import('@/lib/db').prisma;
let POST: typeof import('./route').POST;
import { matchingSources, RADAR_SOURCE_PRESETS } from '@/lib/radar/source-presets';

const ids: string[] = [];
const req = (presetId: string) => new Request('http://localhost/api/admin/radar/source-presets', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ presetId }) }) as never;

describe.skipIf(!allowed)('source preset concurrent transactions on isolated Postgres', () => {
  beforeAll(async () => {
    ({ prisma } = await import('@/lib/db'));
    ({ POST } = await import('./route'));
    const sources = await prisma.radarSource.findMany();
    for (const preset of RADAR_SOURCE_PRESETS) if (matchingSources(preset, sources).length) throw new Error('Fixture source already exists; refusing to change it');
    const user = await prisma.user.create({ data: { email: `radar-preset-${crypto.randomUUID()}@e2e.local`, name: 'Preset integration test', role: 'admin' } });
    actor.id = user.id;
  });
  afterAll(async () => {
    if (actor.id) {
      await prisma.adminAction.deleteMany({ where: { actorId: actor.id, action: 'radar.source_preset_add' } });
      await prisma.radarSource.deleteMany({ where: { id: { in: ids } } });
      await prisma.user.delete({ where: { id: actor.id } });
    }
    await prisma.$disconnect();
  });
  it('serializes concurrent clicks into one source and one audit record', async () => {
    const results = await Promise.all(Array.from({ length: 5 }, () => POST(req('simon-willison-entries'))));
    const bodies = await Promise.all(results.map((response) => response.json()));
    for (const body of bodies) if (body.created) ids.push(body.existing[0].id);
    expect(results.map((response) => response.status).sort()).toEqual([200, 200, 200, 200, 201]);
    expect(new Set(bodies.flatMap((body) => body.existing.map((entry: { id: string }) => entry.id))).size).toBe(1);
    expect(await prisma.adminAction.count({ where: { actorId: actor.id, action: 'radar.source_preset_add' } })).toBe(1);
  });
  it('recognizes a differently identified disabled source without changing it', async () => {
    const existing = await prisma.radarSource.create({ data: { name: `fixture-${crypto.randomUUID()}`, sourceType: 'rss', enabled: false, config: { feedUrl: 'HTTP://WWW.DEVELOPER.NVIDIA.COM:80/blog/feed', maxResults: 4 } } });
    ids.push(existing.id);
    const results = await Promise.all([POST(req('nvidia-developer-blog')), POST(req('nvidia-developer-blog'))]);
    expect(results.map((result) => result.status)).toEqual([200, 200]);
    for (const response of results) expect((await response.json()).existing).toEqual([{ id: existing.id, name: existing.name, enabled: false, autoPaused: false }]);
    const after = await prisma.radarSource.findUniqueOrThrow({ where: { id: existing.id } });
    expect(after).toEqual(existing);
  });
});
