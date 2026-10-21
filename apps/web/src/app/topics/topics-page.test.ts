import { createElement as h } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, beforeEach, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  user: vi.fn(), topics: vi.fn(), follows: vi.fn(), issues: vi.fn(), researches: vi.fn(),
}));
vi.mock('@/lib/auth/session', () => ({ getCurrentUser: mocks.user }));
vi.mock('@/lib/db', () => ({ prisma: {
  topic: { findMany: mocks.topics }, topicFollow: { findMany: mocks.follows },
  topicIssue: { findMany: mocks.issues }, researchTopic: { findMany: mocks.researches },
} }));
vi.mock('./TopicsFilter', () => ({ TopicsFilter: ({ unreadByFilter }: { unreadByFilter: Record<string, number> }) => h('nav', { 'aria-label': '专题筛选' }, `未读 ${unreadByFilter.followed ?? 0}`) }));
import TopicsPage from './page';

const topic = { id: 'topic-a', slug: 'ai-agents', name: '编码代理与检索', tier: 'hot', summary: '真实专题摘要', candidateCount: 7, sourceCount: 2, lastSyncedAt: new Date('2026-10-18T00:00:00Z'), aggregationWindowEnd: new Date('2026-10-18T00:00:00Z') };
const render = async (filter?: string) => renderToStaticMarkup(await TopicsPage({ searchParams: Promise.resolve({ filter }) }));
beforeEach(() => {
  vi.clearAllMocks();
  mocks.user.mockResolvedValue(null);
  mocks.topics.mockResolvedValue([topic]);
  mocks.follows.mockResolvedValue([]);
  mocks.issues.mockResolvedValue([]);
  mocks.researches.mockResolvedValue([]);
});
describe('MUI topics server contract', () => {
  it('renders actual MUI cards, accessible headings, dates and native destinations without old UI classes', async () => {
    const html = await render();
    expect(html).toContain('MuiPaper-root');
    expect(html).toContain('MuiChip-root');
    expect(html).toContain('href="/topics/ai-agents"');
    expect(html).toContain('aria-labelledby="topic-topic-a"');
    expect(html).toContain('<h2 id="topic-topic-a"');
    expect(html).toMatch(/datetime="2026-10-18T00:00:00.000Z"/i);
    expect(html).toContain('7 条相关内容');
    expect(html).toContain('2 个采集渠道');
    expect(html).not.toMatch(/text-(?:xs|sm)|bg-card|rounded-/);
    expect(mocks.topics).toHaveBeenCalledWith(expect.objectContaining({ where: { enabled: true }, take: 80 }));
  });
  it.each(['hot', 'warming', 'emerging'])('preserves %s filtering in the database query', async filter => {
    await render(filter);
    expect(mocks.topics).toHaveBeenCalledWith(expect.objectContaining({ where: { enabled: true, tier: filter } }));
  });
  it('keeps anonymous followed empty without querying any topic data', async () => {
    const html = await render('followed');
    expect(html).toContain('登录后查看已关注专题');
    expect(mocks.topics).not.toHaveBeenCalled();
    expect(mocks.follows).not.toHaveBeenCalled();
    expect(mocks.issues).not.toHaveBeenCalled();
    expect(mocks.researches).not.toHaveBeenCalled();
  });
  it('falls back to all for invalid filters, including prototype names', async () => {
    await render('constructor');
    expect(mocks.topics).toHaveBeenCalledWith(expect.objectContaining({ where: { enabled: true } }));
  });
  it('preserves member follow scope, independent read cursor and active issue counts', async () => {
    mocks.user.mockResolvedValue({ id: 'member-a' });
    mocks.follows.mockResolvedValue([{ topicId: topic.id, lastViewedAt: new Date('2026-10-10T00:00:00Z') }]);
    mocks.issues.mockResolvedValue([
      { topicId: topic.id, id: 'issue-a', title: '新的版本发布', proposition: '代理发布独立版本', kind: 'event', importanceScore: 2, lastSeenAt: new Date('2026-10-18T00:00:00Z'), candidates: [] },
      { topicId: topic.id, id: 'issue-b', title: '已读的研究结果', proposition: '早期独立实验结果', kind: 'event', importanceScore: 1, lastSeenAt: new Date('2026-10-01T00:00:00Z'), candidates: [] },
    ]);
    const html = await render('followed');
    expect(mocks.topics).toHaveBeenCalledWith(expect.objectContaining({ where: { enabled: true, followers: { some: { userId: 'member-a' } } } }));
    expect(html).toContain('已关注');
    expect(html).toContain('1 个新议题');
    expect(html).toContain('2 个活跃议题');
    expect(html).toContain('未读 1');
  });
  it('keeps empty state, missing sync timestamp and related research content', async () => {
    mocks.topics.mockResolvedValue([]);
    expect(await render()).toContain('暂无专题');
    mocks.topics.mockResolvedValue([{ ...topic, lastSyncedAt: null }]);
    mocks.researches.mockResolvedValue([{ topicId: topic.id, research: { id: 'research-a', title: '团队研究', status: 'published' } }]);
    const html = await render();
    expect(html).toContain('待同步');
    expect(html).toContain('已有团队研究：');
    expect(html).toContain('团队研究');
  });
});
