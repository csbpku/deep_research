import { PrismaClient, type Prisma } from '@prisma/client';
import { pathToFileURL } from 'node:url';
import { DEFAULT_RADAR_SOURCES } from './default-radar-sources';

type RadarSourceStore = {
  radarSource: {
    createMany: (args: {
      data: Prisma.RadarSourceCreateManyInput[];
      skipDuplicates: boolean;
    }) => Promise<{ count: number }>;
  };
};

export async function ensureDefaultRadarSources(
  prisma: RadarSourceStore,
): Promise<{ configured: number; created: number }> {
  const result = await prisma.radarSource.createMany({
    data: DEFAULT_RADAR_SOURCES.map((source) => ({
      id: source.id,
      name: source.name,
      sourceType: source.sourceType,
      config: source.config as Prisma.InputJsonValue,
      enabled: source.enabled,
    })),
    skipDuplicates: true,
  });

  return {
    configured: DEFAULT_RADAR_SOURCES.length,
    created: result.count,
  };
}
export async function main(): Promise<void> {
  const prisma = new PrismaClient();
  try {
    const result = await ensureDefaultRadarSources(prisma);
    console.log(
      `[bootstrap:radar] ensured ${result.configured} default sources; created ${result.created} missing source(s)`,
    );
  } finally {
    await prisma.$disconnect();
  }
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  main().catch((error: unknown) => {
    console.error(
      '[bootstrap:radar] failed:',
      error instanceof Error ? error.message : error,
    );
    process.exitCode = 1;
  });
}
