import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ user: vi.fn(), follows: vi.fn(), issues: vi.fn(), researches: vi.fn(), redirect: vi.fn() }));
vi.mock('@/lib/auth/session', () => ({ getCurrentUser: mocks.user }));
vi.mock('@/lib/db', () => ({ prisma: {
  topicFollow: { findMany: mocks.follows }, topicIssue: { findMany: mocks.issues }, researchTopic: { findMany: mocks.researches },
} }));
vi.mock('next/navigation', () => ({ redirect: mocks.redirect }));
import MyTopicsPage from './page';

const viewed = new Date('2026-10-10T00:00:00Z');
const topic = { id: 'topic-a', slug: 'ai-agents', name: '编码代理与检索', tier: 'hot', candidateCount: 30 };
const issue = { id: 'issue-a', topicId: topic.id, title: '独立的验证结果', proposition: '对编码代理的工程验证', kind: 'event', importanceScore: 3, lastSeenAt: new Date('2026-10-18T00:00:00Z'), candidates: [] };
const render = async () => renderToStaticMarkup(await MyTopicsPage());
beforeEach(() => {
  vi.clearAllMocks();
  mocks.user.mockResolvedValue({ id: 'member-a' });
  mocks.follows.mockResolvedValue([{ id: 'follow-a', topicId: topic.id, lastViewedAt: viewed, topic }]);
  mocks.issues.mockResolvedValue([issue]);
  mocks.researches.mockResolvedValue([]);
  mocks.redirect.mockImplementation((path: string) => { throw new Error(`redirect:${path}`); });
});

describe('MUI My Topics server contract', () => {
  it('redirects anonymous access before reading follow or research data', async () => {
    mocks.user.mockResolvedValue(null);
    await expect(render()).rejects.toThrow('redirect:/signin?callbackUrl=/me/topics');
    expect(mocks.follows).not.toHaveBeenCalled();
    expect(mocks.issues).not.toHaveBeenCalled();
    expect(mocks.researches).not.toHaveBeenCalled();
  });
  it('preserves the empty state and native destinations without querying unrelated data', async () => {
    mocks.follows.mockResolvedValue([]);
    const html = await render();
    expect(html).toContain('还没有关注');
    expect(html).toContain('href="/topics"');
    expect(html).toContain('href="/me"');
    expect(mocks.issues).not.toHaveBeenCalled();
    expect(mocks.researches).not.toHaveBeenCalled();
  });
  it('renders real MUI, accessible articles, full topic title and machine-readable view time', async () => {
    const html = await render();
    expect(html).toContain('MuiPaper-root');
    expect(html).toContain('MuiChip-root');
    expect(html).toContain('<article');
    expect(html).toContain('aria-labelledby="followed-topic-topic-a"');
    expect(html).toContain('<h2 id="followed-topic-topic-a"');
    expect(html).toContain('href="/topics/ai-agents"');
    expect(html).toMatch(/datetime="2026-10-10T00:00:00.000Z"/i);
    expect(html).not.toMatch(/text-(?:xs|sm)|bg-card|rounded-|max-w-\[/);
    expect(mocks.follows).toHaveBeenCalledWith({ where: { userId: 'member-a' }, orderBy: [{ lastViewedAt: { sort: 'desc', nulls: 'last' } }, { createdAt: 'desc' }], include: { topic: true } });
    expect(mocks.issues).toHaveBeenCalledWith(expect.objectContaining({ where: { topicId: { in: ['topic-a'] }, status: 'active' } }));
  });
  it('preserves cursor comparison and never-viewed totals, including the equality boundary', async () => {
    const otherTopic = { ...topic, id: 'topic-b', slug: 'rag', name: 'RAG 架构', tier: 'warming' };
    mocks.follows.mockResolvedValue([
      { id: 'follow-a', topicId: topic.id, lastViewedAt: viewed, topic },
      { id: 'follow-b', topicId: otherTopic.id, lastViewedAt: null, topic: otherTopic },
    ]);
    mocks.issues.mockResolvedValue([
      issue,
      { ...issue, id: 'issue-read', title: '早期稳定版本', proposition: '发布稳定版本', lastSeenAt: viewed },
      { ...issue, id: 'issue-b', topicId: otherTopic.id, title: '检索工程实践', proposition: '检索架构实验结果' },
    ]);
    const html = await render();
    expect(html.match(/1 个未读议题/g)).toHaveLength(2);
    expect(html).toContain('2 个活跃议题');
    expect(html).toContain('上次查看 从未');
    expect(html).toContain('共 2 个专题，2 个未读议题');
  });
  it('does not change the issue-collapse and top-issue selection rules', async () => {
    mocks.issues.mockResolvedValue([issue, { ...issue, id: 'issue-duplicate' }]);
    const html = await render();
    expect(html).toContain('1 个活跃议题');
    expect(html).toContain('1 个未读议题');
    expect(html).toContain('独立的验证结果');
    expect(html).toContain('对编码代理的工程验证');
  });
  it('omits empty issue panels and unread badges but retains unknown-tier text', async () => {
    mocks.issues.mockResolvedValue([]);
    mocks.follows.mockResolvedValue([{ id: 'follow-a', topicId: topic.id, lastViewedAt: viewed, topic: { ...topic, tier: 'future' } }]);
    const html = await render();
    expect(html).toContain('future');
    expect(html).toContain('0 个活跃议题');
    expect(html).not.toContain('MuiChip-label">0 个未读议题');
    expect(html).toContain('共 1 个专题，0 个未读议题');
    expect(html).not.toContain('对编码代理的工程验证');
  });
  it('retains the related-research query but fixes the actual research-detail destination', async () => {
    mocks.researches.mockResolvedValue([{ topicId: topic.id, createdAt: viewed, research: { id: 'research-a', title: '验证方法研究', status: 'published' } }]);
    const html = await render();
    expect(html).toContain('已有团队研究');
    expect(html).toContain('href="/researches/research-a"');
    expect(html).not.toContain('href="/research/');
    expect(html).toContain('最近研究：验证方法研究');
    expect(mocks.researches).toHaveBeenCalledWith(expect.objectContaining({ where: { topicId: { in: [topic.id] }, research: { status: 'published' } }, orderBy: { createdAt: 'desc' }, distinct: ['topicId'], take: 2 }));
  });
});
