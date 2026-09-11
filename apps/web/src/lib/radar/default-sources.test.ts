import { describe, expect, it, vi } from 'vitest';
import { DEFAULT_RADAR_SOURCES } from '../../../scripts/default-radar-sources';
import { ensureDefaultRadarSources } from '../../../scripts/bootstrap-radar-sources';

describe('default radar source bootstrap', () => {
  it('ships a useful no-credential source set', () => {
    expect(DEFAULT_RADAR_SOURCES.length).toBeGreaterThanOrEqual(5);
    expect(DEFAULT_RADAR_SOURCES.filter((source) => source.enabled).length).toBeGreaterThan(0);
    expect(DEFAULT_RADAR_SOURCES.map((source) => source.sourceType)).toEqual(
      expect.arrayContaining(['github', 'arxiv', 'rss', 'hn_algolia', 'reddit']),
    );
    expect(new Set(DEFAULT_RADAR_SOURCES.map((source) => source.id)).size).toBe(
      DEFAULT_RADAR_SOURCES.length,
    );
  });

  it('inserts only missing rows and leaves existing rows to the database', async () => {
    const existingId = DEFAULT_RADAR_SOURCES[0]?.id;
    if (!existingId) throw new Error('default source list is empty');
    const rows = new Map<string, unknown>([
      [existingId, { name: 'Custom source name', enabled: false }],
    ]);
    const createMany = vi.fn().mockImplementation(
      async ({
        data,
        skipDuplicates,
      }: {
        data: Array<{ id: string }>;
        skipDuplicates: boolean;
      }) => {
        expect(skipDuplicates).toBe(true);
        let created = 0;
        for (const row of data) {
          if (!rows.has(row.id)) {
            rows.set(row.id, row);
            created += 1;
          }
        }
        return { count: created };
      },
    );

    const result = await ensureDefaultRadarSources({
      radarSource: { createMany },
    });

    expect(result).toEqual({ configured: 22, created: 21 });
    expect(rows.get(existingId)).toEqual({ name: 'Custom source name', enabled: false });
  });

  it('does not keyword-filter the QbitAI editorial feed', () => {
    const qbit = DEFAULT_RADAR_SOURCES.find((source) => source.id.endsWith('022'));
    expect(qbit?.config).toMatchObject({
      feedUrl: 'https://www.qbitai.com/feed',
      applyAiFilter: false,
    });
  });
});
