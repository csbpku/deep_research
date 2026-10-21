// Only for a NEW, isolated local database. Never reads the application's .env.
import { PrismaClient } from '@prisma/client';
import { hashPassword } from '../src/lib/auth/password';
import { seedMuiTopicDetails } from './seed-mui-topic-details';

const target = process.env.MUI_TEST_DATABASE_URL;
if (!target) throw new Error('Set MUI_TEST_DATABASE_URL explicitly; no DATABASE_URL fallback');
const url = new URL(target);
if (!['postgres:', 'postgresql:'].includes(url.protocol) || url.hostname !== '127.0.0.1'
  || url.port !== '55432' || !/^\/deep_research_mui_[a-z0-9_]+$/.test(url.pathname)) {
  throw new Error('MUI fixtures require a dedicated deep_research_mui_* database on 127.0.0.1:55432');
}
const prisma = new PrismaClient({ datasources: { db: { url: target } } });
const detailFixtures = process.env.MUI_DETAIL_FIXTURES === '1';
const detailFixtureDatabases = new Set([
  '/deep_research_mui_detail',
  '/deep_research_mui_e2e_20261020',
]);
if (detailFixtures && !detailFixtureDatabases.has(url.pathname)) {
  throw new Error('Extended detail fixtures require an explicitly approved isolated MUI database');
}
async function seed() {
  const counts = await Promise.all([prisma.user.count(), prisma.topic.count(), prisma.research.count(), prisma.summary.count()]);
  if (counts.some(Boolean)) throw new Error('Refusing to seed a nonempty database; create a fresh isolated database instead');
  const passwordHash = await hashPassword('MUI-local-fixture-only-2026');
  const start = new Date('2026-10-01T00:00:00Z');
  const viewed = new Date('2026-10-10T00:00:00Z');
  const end = new Date('2026-10-18T00:00:00Z');
  await prisma.$transaction(async tx => {
    const member = await tx.user.create({ data: { email: 'mui-member@e2e.local', name: 'MUI 测试成员', passwordHash } });
    const other = await tx.user.create({ data: { email: 'mui-other@e2e.local', name: '另一位测试成员', passwordHash } });
    await tx.user.create({ data: { email: 'mui-admin@e2e.local', name: 'MUI 测试管理员', role: 'admin', passwordHash } });
    await tx.user.create({ data: { email: 'mui-disabled@e2e.local', name: '已禁用测试成员', disabledAt: end, passwordHash } });
    const topics = [];
    for (const [index, tier] of (['hot', 'hot', 'warming', 'warming', 'emerging', 'emerging'] as const).entries()) {
      topics.push(await tx.topic.create({ data: {
        slug: `mui-topic-${index + 1}`, tier,
        name: index === 0 ? 'AI 编码代理与检索增强——跨团队验证的持续研究脉络' : `MUI 专题 ${index + 1}`,
        summary: '把版本变化、工程实践和研究证据串成可追踪的脉络。包含很长的技术标识符：RetrievalAugmentedGenerationWithoutSpacesForResponsiveLayoutVerification。',
        candidateCount: 30 - index, sourceCount: index + 1,
        aggregationWindowStart: start, aggregationWindowEnd: end,
        lastSyncedAt: index === 5 ? null : end,
      } }));
    }
    await tx.topic.create({ data: { slug: 'mui-disabled-topic', name: '不应公开的停用专题', enabled: false, aggregationWindowStart: start, aggregationWindowEnd: end } });
    await tx.topicFollow.createMany({ data: [
      { userId: member.id, topicId: topics[0]!.id, lastViewedAt: viewed },
      { userId: member.id, topicId: topics[2]!.id, lastViewedAt: null },
      { userId: other.id, topicId: topics[4]!.id, lastViewedAt: null },
    ] });
    await tx.topicIssue.createMany({ data: [
      { topicId: topics[0]!.id, kind: 'event', title: '已读的版本发布', proposition: '编码代理发布新的稳定版本', importanceScore: 2, lastSeenAt: start },
      { topicId: topics[0]!.id, kind: 'event', title: '新出现的验证结果', proposition: '独立实验发现代理验证环节出现新的性能变化', importanceScore: 3, lastSeenAt: end },
      { topicId: topics[2]!.id, kind: 'event', title: '从未查看的关注专题', proposition: '检索架构有了新的工程实践', importanceScore: 1, lastSeenAt: end },
    ] });
    const memberResearch = await tx.research.create({ data: {
      type: 'research', status: 'published', title: '编码代理验证方法的团队研究', body: '用于隔离浏览器验收的团队研究。',
      authorId: member.id, publishedAt: end, researchTopics: { create: { topicId: topics[0]!.id } },
    } });
    await tx.userBookmark.create({ data: {
      userId: member.id, targetType: 'research', targetId: memberResearch.id, note: '隔离 MUI 收藏交互夹具。',
    } });
    await tx.research.create({ data: { type: 'research', status: 'draft', title: '另一位成员的私有草稿', body: '不可向其他用户公开。', authorId: other.id } });
    if (detailFixtures) await seedMuiTopicDetails(tx, topics, member.id, start, end);
  });
  console.log('Seeded isolated MUI browser fixtures (6 enabled topics, 4 test identities)');
}
seed().finally(() => prisma.$disconnect()).catch(error => { console.error(error); process.exitCode = 1; });
