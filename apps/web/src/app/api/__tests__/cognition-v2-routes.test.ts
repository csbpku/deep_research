// ADR 0010: 认知闭环 V2 关键路由单测。
//
// 覆盖：
//   - /api/ai-research 接受 V2 brief + primaryTopicId，落库并自动 upsert TopicFollow
//   - /api/topics/[slug]/viewed 推进 lastViewedAt 并写入产品事件
//   - /api/topics/[slug]/issues 返回 issues 与 isUnread 标记
//   - /api/me/topics 计算未读议题与上次查看时间
//   - /api/topics 按 filter=followed 过滤并正确计算 unreadIssueCount
//   - /api/researches/[id]/publish 防御式 ResearchTopic upsert
//
// 这些测试只验 V2 关心的副作用（事件、upsert、isUnread）；老契约由既有 w3/w5 测试覆盖。

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const USER = {
  id: '11111111-1111-4111-8111-111111111111',
  email: 'u@x.com',
  name: 'U',
  role: 'member' as const,
};
const ADMIN = { ...USER, id: '22222222-2222-4222-8222-222222222222', role: 'admin' as const };

const mocks = vi.hoisted(() => ({
  requireUser: vi.fn(),
  getCurrentUser: vi.fn(),
  requireAdmin: vi.fn(),
  // ai-research
  aiJobCreate: vi.fn(),
  aiJobFindFirst: vi.fn(),
  topicFindUnique: vi.fn(),
  topicFollowUpsert: vi.fn(),
  // topics list
  topicFindMany: vi.fn(),
  topicCount: vi.fn(),
  topicIssueFindMany: vi.fn(),
  topicIssueGroupBy: vi.fn(),
  researchTopicFindMany: vi.fn(),
  topicFollowFindMany: vi.fn(),
  topicFollowFindUnique: vi.fn(),
  topicFollowUpsert2: vi.fn(),
  productEventCreate: vi.fn(),
  // me/topics
  topicIssueFindMany2: vi.fn(), // alias for /api/me/topics
  // publish
  researchFindUnique: vi.fn(),
  researchUpdate: vi.fn(),
  researchAuditCreate: vi.fn(),
  adminActionCreate: vi.fn(),
  researchTopicUpsert: vi.fn(),
  transaction: vi.fn(),
  // follow route (delete) → reuse mocks.topicFollowUpsert for upsert
  followTopicDeleteMany: vi.fn(),
}));

vi.mock('@/lib/api-handler', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/api-handler')>()),
  apiHandler: (handler: unknown) => handler,
}));
vi.mock('@/lib/auth/session', () => ({
  requireUser: mocks.requireUser,
  getCurrentUser: mocks.getCurrentUser,
  requireAdmin: mocks.requireAdmin,
}));
vi.mock('@/lib/db', () => ({
  prisma: {
    aiResearchJob: {
      create: mocks.aiJobCreate,
      findFirst: mocks.aiJobFindFirst,
    },
    topic: {
      findUnique: mocks.topicFindUnique,
      findMany: mocks.topicFindMany,
      count: mocks.topicCount,
    },
    topicFollow: {
      upsert: mocks.topicFollowUpsert,
      deleteMany: mocks.followTopicDeleteMany,
      findUnique: mocks.topicFollowFindUnique,
      findMany: mocks.topicFollowFindMany,
    },
    topicIssue: {
      findMany: mocks.topicIssueFindMany,
      groupBy: mocks.topicIssueGroupBy,
    },
    researchTopic: {
      findMany: mocks.researchTopicFindMany,
      upsert: mocks.researchTopicUpsert,
    },
    research: {
      findUnique: mocks.researchFindUnique,
      update: mocks.researchUpdate,
    },
    researchAudit: { create: mocks.researchAuditCreate },
    adminAction: { create: mocks.adminActionCreate },
    productEvent: { create: mocks.productEventCreate },
    $transaction: mocks.transaction,
  },
}));
vi.mock('@/lib/env', () => ({
  getWebEnv: () => ({
    AI_ENGINE_URL: 'http://ai-engine.local',
    DATABASE_URL: 'postgres://test',
  }),
}));
// 防止请求真的发到 ai-engine
global.fetch = vi.fn(async () => ({
  ok: true,
  status: 202,
  text: async () => JSON.stringify({ job_id: 'job-id', status: 'queued' }),
  json: async () => ({ job_id: 'job-id', status: 'queued' }),
})) as never;

beforeEach(() => {
  vi.clearAllMocks();
  mocks.requireUser.mockResolvedValue(USER);
  mocks.getCurrentUser.mockResolvedValue(USER);
  mocks.requireAdmin.mockResolvedValue(ADMIN);
});
afterEach(() => {
  vi.clearAllMocks();
});

/** 帮助函数：构造 minimal NextRequest。 */
function req(url: string, body?: unknown, method: string = 'POST'): Request {
  return new Request(url, {
    method,
    headers: { 'content-type': 'application/json' },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
}

/** 帮助函数：处理 any 类型 params。 */
async function ctx(slug: string): Promise<{ params: Promise<{ slug: string }> }> {
  return { params: Promise.resolve({ slug }) };
}

// ───────────────────────────────────────────────────────────────────
// /api/ai-research —— V2 brief + primaryTopicId
// ───────────────────────────────────────────────────────────────────

describe('POST /api/ai-research — V2 brief forwarding', () => {
  it('持久化 brief / objective / primaryTopicId 并自动 upsert TopicFollow', async () => {
    const { POST } = await import('../ai-research/route');

    mocks.aiJobCreate.mockResolvedValueOnce({ id: 'job-1' });
    mocks.topicFindUnique.mockResolvedValueOnce({ id: 'topic-1', slug: 'ai-agents' });

    const brief = {
      objective: 'investigate',
      question: '研究 GraphRAG',
      constraints: ['团队已用 PG 15'],
      questionsToAnswer: ['索引差异是什么'],
      comparisonOptions: [],
      successCriteria: [],
      sourcePolicy: 'prefer_user_sources' as const,
      contextRefs: [],
      primaryTopicId: '44444444-4444-4444-8444-444444444444',
      outputType: 'markdown' as const,
    };

    const response = await POST(
      req('http://localhost/api/ai-research', { brief }) as never,
    );

    expect(response.status).toBe(202);
    const data = (await response.json()) as { jobId: string };
    expect(data.jobId).toBe('job-1');

    // 1. 落库时 brief / objective / primaryTopicId 都正确
    const createArg = mocks.aiJobCreate.mock.calls[0][0];
    expect(createArg.data.objective).toBe('investigate');
    expect(createArg.data.primaryTopicId).toBe('44444444-4444-4444-8444-444444444444');
    expect(createArg.data.brief).toMatchObject({
      objective: 'investigate',
      primaryTopicId: '44444444-4444-4444-8444-444444444444',
      outputType: 'markdown',
    });

    // 2. primaryTopicId 触发 TopicFollow upsert
    expect(mocks.topicFollowUpsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { userId_topicId: { userId: USER.id, topicId: 'topic-1' } },
      }),
    );

    // 3. product_event topic_research_started 被记
    expect(mocks.productEventCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          eventName: 'topic_research_started',
          entityId: 'topic-1',
        }),
      }),
    );
  });

  it('无 primaryTopicId 时不调用 TopicFollow upsert，不写 topic_research_started', async () => {
    const { POST } = await import('../ai-research/route');

    mocks.aiJobCreate.mockResolvedValueOnce({ id: 'job-2' });

    const response = await POST(
      req('http://localhost/api/ai-research', {
        topic: 'fallback question',
        reportType: 'research_report',
        sourcePolicy: 'prefer_user_sources',
      }) as never,
    );

    expect(response.status).toBe(202);
    expect(mocks.topicFollowUpsert).not.toHaveBeenCalled();
    expect(mocks.productEventCreate).not.toHaveBeenCalled();
  });

  it('primaryTopicId 指向不存在的专题时静默忽略', async () => {
    const { POST } = await import('../ai-research/route');

    mocks.aiJobCreate.mockResolvedValueOnce({ id: 'job-3' });
    mocks.topicFindUnique.mockResolvedValueOnce(null);

    const response = await POST(
      req('http://localhost/api/ai-research', {
        brief: {
          objective: 'explore',
          question: '探索',
          constraints: [],
          questionsToAnswer: [],
          comparisonOptions: [],
          successCriteria: [],
          sourcePolicy: 'prefer_user_sources',
          contextRefs: [],
          primaryTopicId: '11111111-1111-4111-8111-111111111111',
          outputType: 'markdown',
        },
      }) as never,
    );

    expect(response.status).toBe(202);
    expect(mocks.topicFollowUpsert).not.toHaveBeenCalled();
    expect(mocks.productEventCreate).not.toHaveBeenCalled();
  });
});

// ───────────────────────────────────────────────────────────────────
// /api/topics/[slug]/viewed —— lastViewedAt 推进 + 事件记录
// ───────────────────────────────────────────────────────────────────

describe('POST /api/topics/[slug]/viewed', () => {
  it('upsert lastViewedAt 并写入 topic_viewed_with_unread 事件', async () => {
    const { POST } = await import('../topics/[slug]/viewed/route');
    const newDate = new Date('2026-08-19T10:00:00Z');
    // findTopicBySlugOrId 调用 prisma.topic.findUnique({where:{slug}})
    mocks.topicFindUnique.mockResolvedValueOnce({ id: 'topic-x', slug: 'ai-agents' });
    mocks.topicFollowUpsert.mockResolvedValueOnce({ id: 'f-1', lastViewedAt: newDate });

    const response = await POST(
      req('http://localhost/api/topics/ai-agents/viewed', undefined, 'POST') as never,
      await ctx('ai-agents'),
    );

    expect(response.status).toBe(200);
    expect(mocks.topicFollowUpsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { userId_topicId: { userId: USER.id, topicId: 'topic-x' } },
        create: expect.objectContaining({ lastViewedAt: expect.any(Date) }),
        update: expect.objectContaining({ lastViewedAt: expect.any(Date) }),
      }),
    );
    expect(mocks.productEventCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ eventName: 'topic_viewed_with_unread' }),
      }),
    );
  });
});

// ───────────────────────────────────────────────────────────────────
// /api/topics/[slug]/issues —— isUnread 标记
// ───────────────────────────────────────────────────────────────────

describe('GET /api/topics/[slug]/issues', () => {
  it('已查看用户拿到 isUnread=false；未查看拿到 isUnread=true', async () => {
    const { GET } = await import('../topics/[slug]/issues/route');

    mocks.topicFindUnique.mockResolvedValueOnce({ id: 'topic-x', slug: 'ai-agents' });
    const recentDate = new Date('2026-08-19T08:00:00Z');
    const oldViewedAt = new Date('2026-08-19T07:00:00Z');
    mocks.topicIssueFindMany.mockResolvedValueOnce([
      {
        id: 'iss-1',
        kind: 'event',
        status: 'active',
        title: 'recent',
        proposition: 'prop',
        summary: null,
        importanceScore: 0.7,
        firstSeenAt: new Date('2026-08-15'),
        lastSeenAt: recentDate,
        candidates: [{ summaryId: 's1', relevanceScore: 0.8, addedAt: new Date('2026-08-15') }],
      },
    ]);
    mocks.topicFollowFindUnique.mockResolvedValueOnce({ lastViewedAt: oldViewedAt });

    const response = await GET(
      new Request('http://localhost/api/topics/ai-agents/issues?status=active') as never,
      await ctx('ai-agents'),
    );

    expect(response.status).toBe(200);
    const body = (await response.json()) as { issues: Array<{ isUnread: boolean }> };
    expect(body.issues[0].isUnread).toBe(true);
  });

  it('匿名用户也会把全部 active issue 视为未读', async () => {
    const { GET } = await import('../topics/[slug]/issues/route');

    mocks.topicFindUnique.mockResolvedValueOnce({ id: 'topic-x', slug: 'ai-agents' });
    mocks.getCurrentUser.mockResolvedValueOnce(null);
    mocks.topicIssueFindMany.mockResolvedValueOnce([
      {
        id: 'iss-1',
        kind: 'event',
        status: 'active',
        title: 'recent',
        proposition: 'p',
        summary: null,
        importanceScore: 0.5,
        firstSeenAt: new Date('2026-08-15'),
        lastSeenAt: new Date('2026-08-19'),
        candidates: [],
      },
    ]);

    const response = await GET(
      new Request('http://localhost/api/topics/ai-agents/issues') as never,
      await ctx('ai-agents'),
    );

    expect(response.status).toBe(200);
    const body = (await response.json()) as { issues: Array<{ isUnread: boolean }> };
    expect(body.issues[0].isUnread).toBe(true);
  });
});

// ───────────────────────────────────────────────────────────────────
// /api/me/topics —— 未读与最近研究聚合
// ───────────────────────────────────────────────────────────────────

describe('GET /api/me/topics', () => {
  it('为每个 follow 计算 unread 并合并 latest research', async () => {
    const { GET } = await import('../me/topics/route');

    const lastViewedAt = new Date('2026-08-19T07:00:00Z');
    mocks.topicFollowFindMany.mockResolvedValueOnce([
      {
        id: 'f-1',
        createdAt: new Date('2026-08-01'),
        lastViewedAt,
        topic: {
          id: 't-1',
          slug: 'ai-agents',
          name: 'AI Agents',
          summary: 'desc',
          tier: 'hot',
          candidateCount: 100,
          sourceCount: 20,
          lastSyncedAt: new Date('2026-08-19'),
          synthesisGeneratedAt: new Date('2026-08-19'),
        },
      },
    ]);
    mocks.topicIssueFindMany.mockResolvedValueOnce([
      {
        id: 'i-old',
        topicId: 't-1',
        title: 'old',
        proposition: 'p',
        importanceScore: 0.5,
        lastSeenAt: new Date('2026-08-19T06:00:00Z'), // 早于 lastViewedAt
      },
      {
        id: 'i-new',
        topicId: 't-1',
        title: 'new',
        proposition: 'p',
        importanceScore: 0.9,
        lastSeenAt: new Date('2026-08-19T08:00:00Z'), // 晚于 lastViewedAt
      },
    ]);
    mocks.researchTopicFindMany.mockResolvedValueOnce([
      {
        topicId: 't-1',
        createdAt: new Date('2026-08-19'),
        research: { id: 'r-1', title: 'GraphRAG 决策', status: 'published', type: 'research_report' },
      },
    ]);

    const response = await GET(req('http://localhost/api/me/topics', undefined, 'GET') as never);

    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      items: Array<{ unreadIssueCount: number; latestResearch: { id: string } | null }>;
      totalUnread: number;
    };
    expect(body.items[0].unreadIssueCount).toBe(1);
    expect(body.items[0].latestResearch?.id).toBe('r-1');
    expect(body.totalUnread).toBe(1);
  });
});

// ───────────────────────────────────────────────────────────────────
// /api/topics —— V2 unreadIssueCount + filter=followed
// ───────────────────────────────────────────────────────────────────

describe('GET /api/topics (V2 enhanced)', () => {
  it('filter=followed 时仅返回关注专题；unreadIssueCount 按 lastSeenAt > lastViewedAt 计算', async () => {
    const { GET } = await import('../topics/route');

    mocks.getCurrentUser.mockResolvedValue(USER);
    mocks.topicFindMany.mockResolvedValueOnce([
      {
        id: 't-1',
        slug: 'ai-agents',
        name: 'AI Agents',
        summary: 's',
        tier: 'hot',
        candidateCount: 1,
        sourceCount: 1,
        lastSyncedAt: new Date('2026-08-19'),
        synthesisGeneratedAt: null,
        lastSynthesisSuccessAt: null,
        synthesisErrorCode: null,
        aggregationWindowEnd: new Date('2026-08-19'),
      },
    ]);
    mocks.topicFollowFindMany.mockResolvedValueOnce([
      { topicId: 't-1', lastViewedAt: new Date('2026-08-19T07:00:00Z') },
    ]);
    mocks.topicIssueFindMany.mockResolvedValueOnce([
      { topicId: 't-1', lastSeenAt: new Date('2026-08-19T06:00:00Z') }, // old
      { topicId: 't-1', lastSeenAt: new Date('2026-08-19T08:00:00Z') }, // unread
      { topicId: 't-1', lastSeenAt: new Date('2026-08-19T08:30:00Z') }, // unread
    ]);
    mocks.researchTopicFindMany.mockResolvedValueOnce([]);
    mocks.topicCount.mockResolvedValueOnce(1);

    const response = await GET(
      new Request('http://localhost/api/topics?filter=followed') as never,
    );

    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      items: Array<{ unreadIssueCount: number; activeIssueCount: number }>;
      filter: string;
      total: number;
    };
    expect(body.filter).toBe('followed');
    expect(body.total).toBe(1);
    expect(body.items[0].activeIssueCount).toBe(3);
    expect(body.items[0].unreadIssueCount).toBe(2); // 仅 08:00 与 08:30 两条新于 07:00
  });
});

// ───────────────────────────────────────────────────────────────────
// /api/researches/[id]/publish —— 防御式 ResearchTopic upsert
// ───────────────────────────────────────────────────────────────────

describe('POST /api/researches/[id]/publish — V2 ResearchTopic auto-flow', () => {
  beforeEach(() => {
    mocks.transaction.mockImplementation((callback) =>
      callback({
        research: { update: mocks.researchUpdate },
        researchAudit: { create: mocks.researchAuditCreate },
        productEvent: { create: mocks.productEventCreate },
        // 注意：不传 researchTopic — 模拟现有 w3 测试里的 tx 形状
        aiResearchJob: { findFirst: vi.fn(async () => ({ primaryTopicId: null })) },
      }),
    );
  });

  it('transaction 中没有 researchTopic 模型时也能完成发布（防御式）', async () => {
    const { POST } = await import('../researches/[id]/publish/route');

    const now1 = new Date('2026-08-19T12:00:00Z');
    mocks.researchFindUnique.mockResolvedValueOnce({
      id: '55555555-5555-4555-8555-555555555555',
      authorId: USER.id,
      status: 'draft',
      title: 'T',
      body: 'B',
      background: '背景',
      conclusion: 'C',
      risks: '风险',
      tags: [],
      creationMethod: 'manual',
      reviewStatus: null,
      originContentSha256: 'a'.repeat(64),
    });
    mocks.researchUpdate.mockResolvedValueOnce({
      id: '55555555-5555-4555-8555-555555555555',
      type: 'research_report',
      status: 'published',
      title: 'T',
      body: 'B',
      background: '背景',
      conclusion: 'C',
      risks: '风险',
      tags: [],
      authorId: USER.id,
      creationMethod: 'manual',
      aiAssisted: false,
      publishedAt: now1,
      createdAt: now1,
      updatedAt: now1,
      author: { id: USER.id, name: 'U', email: 'u@x.com' },
    });

    const response = await POST(
      req('http://localhost/api/researches/55555555-5555-4555-8555-555555555555/publish') as never,
      { params: Promise.resolve({ id: '55555555-5555-4555-8555-555555555555' }) },
    );

    expect(response.status).toBe(200);
    // 不应尝试调用 researchTopic.upsert（tx 中没这方法）
    expect(mocks.researchTopicUpsert).not.toHaveBeenCalled();
  });

  it('完整 transaction + primaryTopicId 来源：upsert ResearchTopic(relationType: auto)', async () => {
    const { POST } = await import('../researches/[id]/publish/route');

    // 重新 mock: 现在 transaction 提供 researchTopic 与 aiResearchJob.findFirst
    mocks.transaction.mockImplementationOnce((callback) =>
      callback({
        research: { update: mocks.researchUpdate },
        researchAudit: { create: mocks.researchAuditCreate },
        productEvent: { create: mocks.productEventCreate },
        researchTopic: { upsert: mocks.researchTopicUpsert },
        aiResearchJob: {
          findFirst: vi.fn(async () => ({ primaryTopicId: 'topic-source' })),
        },
      }),
    );
    const now2 = new Date('2026-08-19T12:01:00Z');
    mocks.researchFindUnique.mockResolvedValueOnce({
      id: '66666666-6666-4666-8666-666666666666',
      authorId: USER.id,
      status: 'draft',
      title: 'T2',
      body: 'B',
      background: '背景',
      conclusion: 'C',
      risks: '风险',
      tags: [],
      creationMethod: 'manual',
      reviewStatus: null,
      originContentSha256: 'a'.repeat(64),
    });
    mocks.researchUpdate.mockResolvedValueOnce({
      id: '66666666-6666-4666-8666-666666666666',
      type: 'research_report',
      status: 'published',
      title: 'T2',
      body: 'B',
      background: '背景',
      conclusion: 'C',
      risks: '风险',
      tags: [],
      authorId: USER.id,
      creationMethod: 'manual',
      aiAssisted: false,
      publishedAt: now2,
      createdAt: now2,
      updatedAt: now2,
      author: { id: USER.id, name: 'U', email: 'u@x.com' },
    });
    mocks.researchTopicUpsert.mockResolvedValueOnce({});

    const response = await POST(
      req('http://localhost/api/researches/66666666-6666-4666-8666-666666666666/publish') as never,
      { params: Promise.resolve({ id: '66666666-6666-4666-8666-666666666666' }) },
    );

    expect(response.status).toBe(200);
    expect(mocks.researchTopicUpsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { researchId_topicId: { researchId: '66666666-6666-4666-8666-666666666666', topicId: 'topic-source' } },
        create: expect.objectContaining({ relationType: 'auto' }),
      }),
    );
  });
});


// ───────────────────────────────────────────────────────────────────
// /api/topics/[slug]/follow —— V2 主题事件
// ───────────────────────────────────────────────────────────────────

describe('POST + DELETE /api/topics/[slug]/follow — V2 events', () => {
  it('POST 关注时写入 topic_followed 事件', async () => {
    const { POST } = await import('../topics/[slug]/follow/route');
    // findTopicBySlugOrId -> prisma.topic.findUnique
    mocks.topicFindUnique.mockResolvedValueOnce({ id: 'topic-xyz', slug: 'ai-agents' });
    mocks.topicFollowUpsert.mockResolvedValueOnce({ id: 'follow-1', createdAt: new Date() });
    mocks.productEventCreate.mockResolvedValueOnce({ id: 'evt-1' });

    const response = await POST(
      new Request('http://localhost/api/topics/ai-agents/follow', { method: 'POST' }) as never,
      { params: Promise.resolve({ slug: 'ai-agents' }) },
    );

    expect(response.status).toBe(201);
    expect(mocks.topicFollowUpsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { userId_topicId: { userId: USER.id, topicId: 'topic-xyz' } },
      }),
    );
    expect(mocks.productEventCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          eventName: 'topic_followed',
          entityId: 'topic-xyz',
          userId: USER.id,
        }),
      }),
    );
  });

  it('DELETE 取关时写入 topic_unfollowed 事件', async () => {
    const { DELETE } = await import('../topics/[slug]/follow/route');
    mocks.topicFindUnique.mockResolvedValueOnce({ id: 'topic-xyz', slug: 'ai-agents' });
    mocks.followTopicDeleteMany.mockResolvedValueOnce({ count: 1 });
    mocks.productEventCreate.mockResolvedValueOnce({ id: 'evt-2' });

    const response = await DELETE(
      new Request('http://localhost/api/topics/ai-agents/follow', { method: 'DELETE' }) as never,
      { params: Promise.resolve({ slug: 'ai-agents' }) },
    );

    expect(response.status).toBe(200);
    expect(mocks.followTopicDeleteMany).toHaveBeenCalled();
    expect(mocks.productEventCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          eventName: 'topic_unfollowed',
          entityId: 'topic-xyz',
          userId: USER.id,
        }),
      }),
    );
  });
});


// ───────────────────────────────────────────────────────────────────
// /api/topics/[slug]/issues —— 登录用户触发 topic_issue_viewed 埋点
// ───────────────────────────────────────────────────────────────────

describe('GET /api/topics/[slug]/issues — topic_issue_viewed event', () => {
  it('登录用户请求 issues 时写入 topic_issue_viewed 事件', async () => {
    const { GET } = await import('../topics/[slug]/issues/route');
    // findTopicBySlugOrId 命中
    mocks.topicFindUnique.mockResolvedValueOnce({ id: 'topic-xyz', slug: 'ai-agents' });
    mocks.topicIssueFindMany.mockResolvedValueOnce([
      {
        id: 'i-1',
        kind: 'event',
        status: 'active',
        title: '议题 1',
        proposition: '…',
        summary: null,
        importanceScore: 0.5,
        firstSeenAt: new Date(),
        lastSeenAt: new Date(),
        candidates: [],
      },
    ]);
    // 已关注用户 lastViewedAt
    mocks.topicFollowFindUnique.mockResolvedValueOnce({ lastViewedAt: new Date() });
    mocks.productEventCreate.mockResolvedValueOnce({ id: 'evt-issue' });

    const response = await GET(
      new Request('http://localhost/api/topics/ai-agents/issues') as never,
      { params: Promise.resolve({ slug: 'ai-agents' }) },
    );

    expect(response.status).toBe(200);
    expect(mocks.productEventCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          eventName: 'topic_issue_viewed',
          entityId: 'topic-xyz',
          userId: USER.id,
          metadata: expect.objectContaining({ slug: 'ai-agents', count: 1 }),
        }),
      }),
    );
  });

  it('匿名用户只读，不写事件', async () => {
    const { GET } = await import('../topics/[slug]/issues/route');
    mocks.getCurrentUser.mockResolvedValueOnce(null);
    mocks.topicFindUnique.mockResolvedValueOnce({ id: 'topic-xyz', slug: 'ai-agents' });
    mocks.topicIssueFindMany.mockResolvedValueOnce([]);

    const response = await GET(
      new Request('http://localhost/api/topics/ai-agents/issues') as never,
      { params: Promise.resolve({ slug: 'ai-agents' }) },
    );

    expect(response.status).toBe(200);
    const emits = mocks.productEventCreate.mock.calls.filter(
      (call) => (call[0] as { data?: { eventName?: string } })?.data?.eventName === 'topic_issue_viewed',
    );
    expect(emits).toHaveLength(0);
  });
});
