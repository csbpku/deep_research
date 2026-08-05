// E2E/本地试跑用的最小 seed 脚本。
//
// 用途：让 E2E 测试有少量数据可读，不至于全空跳过所有断言。
// CI 触发：手动 dispatch 或本地 `E2E=1 pnpm db:seed:e2e`。
//
// 设计：写入最小数据；与生产数据物理隔离（test schema 默认）。
// 运行：cd apps/web && DATABASE_URL=... pnpm db:seed:e2e

import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
  console.log('[seed:e2e] starting');

  // Admin user（E2E Credentials provider 会 upsert；这里预置更好）
  const adminEmail = 'e2e-admin@example.com';
  await prisma.user.upsert({
    where: { email: adminEmail },
    update: { role: 'admin' },
    create: {
      email: adminEmail,
      name: 'E2E Admin',
      role: 'admin',
    },
  });
  console.log('[seed:e2e] admin user ensured');

  // Member user
  await prisma.user.upsert({
    where: { email: 'member@e2e.local' },
    update: {},
    create: {
      email: 'member@e2e.local',
      name: 'E2E Member',
      role: 'member',
    },
  });
  console.log('[seed:e2e] member user ensured');

  // 一条已发布 research
  const existingResearch = await prisma.research.findFirst({
    where: { title: 'E2E Seed Research' },
  });
  if (!existingResearch) {
    const member = await prisma.user.findUnique({ where: { email: 'member@e2e.local' } });
    if (member) {
      await prisma.research.create({
        data: {
          type: 'research',
          status: 'published',
          title: 'E2E Seed Research',
          body: 'This is the E2E seed research body.\n\n## Section\n\nSome content here.',
          background: 'Background for E2E seed.',
          conclusion: 'Conclusion for E2E seed.',
          risks: 'Risks for E2E seed.',
          tags: ['e2e', 'seed'],
          authorId: member.id,
          publishedAt: new Date(),
        },
      });
      console.log('[seed:e2e] seed research created');
    }
  }

  // 一条已发布 summary
  const existingSummary = await prisma.summary.findFirst({
    where: { title: 'E2E Seed Summary' },
  });
  if (!existingSummary) {
    await prisma.summary.create({
      data: {
        title: 'E2E Seed Summary',
        body: 'E2E seed summary body.',
        url: 'https://e2e.local/seed-summary',
        canonicalUrl: 'https://e2e.local/seed-summary',
        source: 'user',
        contentOrigin: 'web',
        status: 'published',
        tags: ['e2e'],
        summaryDate: new Date(),
        publishedAt: new Date(),
      },
    });
    console.log('[seed:e2e] seed summary created');
  }

  console.log('[seed:e2e] done');
}

main()
  .catch((e) => {
    console.error('[seed:e2e] failed:', e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
