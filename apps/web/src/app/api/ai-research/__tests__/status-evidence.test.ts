import { beforeEach, describe, expect, it, vi } from 'vitest';
import { hashResearchRevision } from '@/lib/research-revision';

const USER_ID = '11111111-1111-4111-8111-111111111111';
const JOB_ID = '22222222-2222-4222-8222-222222222222';

const mocks = vi.hoisted(() => ({
  requireUser: vi.fn(),
  jobFindUnique: vi.fn(),
  researchFindUnique: vi.fn(),
  fetchAiEngine: vi.fn(),
}));

vi.mock('@/lib/api-handler', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/api-handler')>()),
  apiHandler: (handler: unknown) => handler,
}));
vi.mock('@/lib/auth/session', () => ({ requireUser: mocks.requireUser }));
vi.mock('@/lib/db', () => ({
  prisma: {
    aiResearchJob: { findUnique: mocks.jobFindUnique },
    research: { findUnique: mocks.researchFindUnique },
  },
}));
vi.mock('@/lib/env', () => ({ getWebEnv: () => ({ AI_ENGINE_URL: 'http://ai.test' }) }));
vi.mock('@/lib/ai-bff/fetch-ai-engine', () => ({ fetchAiEngine: mocks.fetchAiEngine }));

import { GET } from '../[jobId]/route';

function request() {
  return new Request(`http://localhost/api/ai-research/${JOB_ID}`) as never;
}

beforeEach(() => {
  vi.resetAllMocks();
  mocks.requireUser.mockResolvedValue({ id: USER_ID, role: 'member' });
  mocks.researchFindUnique.mockResolvedValue(null);
  mocks.fetchAiEngine.mockResolvedValue({
    ok: true,
    status: 200,
    body: {
      job_id: JOB_ID,
      status: 'stored',
      final_status: 'succeeded',
      report_type: 'research_report',
      topic: 'GraphRAG 选型',
      output_text: '',
      draft_research_id: '33333333-3333-4333-8333-333333333333',
      sources_count: 1,
    },
  });
});

describe('GET /api/ai-research/[jobId] evidence workspace', () => {
  it('hides a job owned by another user', async () => {
    mocks.jobFindUnique.mockResolvedValue({ requesterId: 'someone-else' });
    const response = await GET(request(), { params: Promise.resolve({ jobId: JOB_ID }) });
    expect(response.status).toBe(404);
    expect(mocks.fetchAiEngine).not.toHaveBeenCalled();
  });

  it('returns saved evidence and the draft body as an inline report', async () => {
    mocks.jobFindUnique.mockResolvedValue({
      requesterId: USER_ID,
      context: '团队规模 4 人；只关注可回滚的落地方案。',
      brief: {
        objective: 'decide',
        question: 'GraphRAG 选型',
        scope: { timeRange: { preset: '30d' }, regions: [], technologyVersions: [] },
        constraints: ['优先低成本方案'],
        questionsToAnswer: ['是否值得采用？'],
        comparisonOptions: ['GraphRAG', '向量检索'],
        successCriteria: ['能在两周内验证'],
        sourcePolicy: 'prefer_user_sources',
        contextRefs: [],
        outputType: 'markdown',
      },
      conversation: [],
      draftResearch: { title: 'GraphRAG 采用建议', body: '# 结论\n\n建议先做小规模验证。' },
      aiResearchSources: [{
        id: '44444444-4444-4444-8444-444444444444',
        title: 'GraphRAG documentation',
        snippet: 'Official architecture and indexing guidance.',
        score: 0.92,
        sourceRef: { type: 'url', value: 'https://example.com/graphrag' },
        canonicalKey: 'https://example.com/graphrag',
        stepCaptured: 'search',
        createdAt: new Date('2026-09-01T00:00:00Z'),
      }],
    });

    const response = await GET(request(), { params: Promise.resolve({ jobId: JOB_ID }) });
    expect(response.status).toBe(200);
    const payload = await response.json();
    expect(payload.artifact).toMatchObject({
      title: '结论',
      content: '# 结论\n\n建议先做小规模验证。',
      type: 'markdown',
    });
    expect(payload.sources).toEqual([expect.objectContaining({
      title: 'GraphRAG documentation',
      href: 'https://example.com/graphrag',
      stepCaptured: 'search',
    })]);
    expect(payload.context).toBe('团队规模 4 人；只关注可回滚的落地方案。');
    expect(payload.brief).toMatchObject({ objective: 'decide', question: 'GraphRAG 选型' });
  });

  it('projects claim-evidence additions from the durable research ledger', async () => {
    mocks.jobFindUnique.mockResolvedValue({
      requesterId: USER_ID,
      context: null,
      sourceRefs: [],
      brief: null,
      conversation: [],
      partialSources: [],
      updatedAt: new Date('2026-09-01T00:00:00Z'),
      draftResearch: {
        title: '补证后的报告',
        body: '# 结论\n\n补证后仍是同一份正文。',
        researchSources: [
          {
            id: 'source-ledger-1',
            sourceRef: { type: 'url', value: 'https://example.com/original' },
            canonicalKey: 'https://example.com/original',
            title: 'Original source',
            description: 'Original captured paragraph.',
            createdAt: new Date('2026-09-01T00:00:00Z'),
          },
          {
            id: 'source-ledger-2',
            sourceRef: { type: 'url', value: 'https://example.com/new-evidence' },
            canonicalKey: 'https://example.com/new-evidence',
            title: 'New evidence',
            description: 'Added by the claim-scoped evidence task.',
            createdAt: new Date('2026-09-02T00:00:00Z'),
          },
        ],
      },
      aiResearchSources: [{
        id: 'job-source-1',
        title: 'Original source',
        snippet: 'Original captured paragraph.',
        score: 0.9,
        sourceRef: { type: 'url', value: 'https://example.com/original' },
        canonicalKey: 'https://example.com/original',
        stepCaptured: 'search',
        createdAt: new Date('2026-09-01T00:00:00Z'),
      }],
      _count: { aiResearchSources: 1 },
    });

    const response = await GET(request(), { params: Promise.resolve({ jobId: JOB_ID }) });
    const payload = await response.json();

    expect(payload.savedSourcesCount).toBe(2);
    expect(payload.capturedSourcesCount).toBe(2);
    expect(payload.sources).toEqual([
      expect.objectContaining({
        title: 'Original source',
        href: 'https://example.com/original',
        stepCaptured: 'research_ledger',
      }),
      expect.objectContaining({
        title: 'New evidence',
        href: 'https://example.com/new-evidence',
        snippet: 'Added by the claim-scoped evidence task.',
      }),
    ]);
  });

  it('does not expose a previous passed mirror while the current revision is queued', async () => {
    const revisionHash = hashResearchRevision({
      title: '当前版本',
      body: '# 结论\n\n新版本内容',
      background: null,
      conclusion: null,
      risks: null,
      tags: [],
    });
    mocks.jobFindUnique.mockResolvedValue({
      requesterId: USER_ID,
      context: null,
      sourceRefs: [],
      brief: null,
      conversation: [],
      updatedAt: new Date('2026-09-01T00:00:00Z'),
      draftResearch: {
        title: '当前版本',
        body: '# 结论\n\n新版本内容',
        background: null,
        conclusion: null,
        risks: null,
        tags: [],
        audit: [],
        reviewRuns: [{
          id: '66666666-6666-4666-8666-666666666666',
          revisionHash,
          sourceSnapshotHash: 'source-snapshot',
          policyVersion: 'fact-review-v1',
          executionStatus: 'queued',
          outcome: null,
          attempt: 0,
          startedAt: null,
          leaseExpiresAt: null,
          heartbeatAt: null,
          completedAt: null,
          summary: null,
          claims: [],
          details: { phase: 'queued' },
          triggeredBy: 'manual',
          createdAt: new Date('2026-09-02T00:00:00Z'),
        }],
      },
      aiResearchSources: [],
      _count: { aiResearchSources: 0 },
    });
    mocks.fetchAiEngine.mockResolvedValue({
      ok: true,
      status: 200,
      body: {
        job_id: JOB_ID,
        status: 'stored',
        final_status: 'succeeded',
        report_type: 'research_report',
        topic: '当前版本',
        output_text: '# 旧镜像内容',
        draft_research_id: '33333333-3333-4333-8333-333333333333',
        sources_count: 0,
        review: { phase: 'completed', status: 'passed', claims: [{ claim: '旧声明' }] },
      },
    });

    const response = await GET(request(), { params: Promise.resolve({ jobId: JOB_ID }) });
    const payload = await response.json();

    expect(payload.review).toMatchObject({ phase: 'queued', status: 'queued', claims: [] });
    expect(payload.reviewRun).toMatchObject({ executionStatus: 'queued', isCurrentRevision: true });
  });

  it('does not expose claims from a historical revision when the current revision is stale', async () => {
    const currentRevisionHash = hashResearchRevision({
      title: '当前版本',
      body: '# 结论\n\n新版本内容',
      background: null,
      conclusion: null,
      risks: null,
      tags: [],
    });
    mocks.jobFindUnique.mockResolvedValue({
      requesterId: USER_ID,
      context: null,
      sourceRefs: [],
      brief: null,
      conversation: [],
      updatedAt: new Date('2026-09-01T00:00:00Z'),
      draftResearch: {
        title: '当前版本',
        body: '# 结论\n\n新版本内容',
        background: null,
        conclusion: null,
        risks: null,
        tags: [],
        audit: [],
        reviewRuns: [{
          id: '77777777-7777-4777-8777-777777777777',
          revisionHash: 'old-revision',
          sourceSnapshotHash: 'old-source-snapshot',
          policyVersion: 'fact-review-v1',
          executionStatus: 'completed',
          outcome: 'clear',
          attempt: 1,
          startedAt: null,
          leaseExpiresAt: null,
          heartbeatAt: null,
          completedAt: new Date('2026-09-02T00:00:00Z'),
          summary: { factual_claim_count: 1 },
          claims: [{ claim: '上一版声明', verdict: 'verified' }],
          details: { status: 'passed' },
          triggeredBy: 'system',
          createdAt: new Date('2026-09-02T00:00:00Z'),
        }],
      },
      aiResearchSources: [],
      _count: { aiResearchSources: 0 },
    });
    mocks.fetchAiEngine.mockResolvedValue({
      ok: true,
      status: 200,
      body: {
        job_id: JOB_ID,
        status: 'stored',
        final_status: 'succeeded',
        report_type: 'research_report',
        topic: '当前版本',
        output_text: '# 当前报告',
        draft_research_id: '33333333-3333-4333-8333-333333333333',
        sources_count: 0,
        review: { phase: 'completed', status: 'passed', claims: [{ claim: '上一版声明' }] },
      },
    });

    const response = await GET(request(), { params: Promise.resolve({ jobId: JOB_ID }) });
    const payload = await response.json();

    expect(currentRevisionHash).not.toBe('old-revision');
    expect(payload.review).toMatchObject({ status: 'stale', claims: [], summary: null });
    expect(payload.reviewRun).toMatchObject({ executionStatus: 'stale', isCurrentRevision: false });
  });

  it('falls back to legacy partialSources when normalized evidence rows are absent', async () => {
    mocks.jobFindUnique.mockResolvedValue({
      requesterId: USER_ID,
      conversation: [],
      partialSources: [{
        source_ref: { type: 'url', value: 'https://legacy.example/report' },
        canonical_key: 'https://legacy.example/report',
        title: 'Legacy evidence',
        snippet: 'Saved before normalized source rows were introduced.',
        score: 0.8,
        step_captured: 'search',
      }],
      updatedAt: new Date('2026-08-31T00:00:00Z'),
      draftResearch: {
        title: 'Legacy report',
        body: '# 结论\n\n[原始证据](https://legacy.example/report)',
      },
      aiResearchSources: [],
    });

    const response = await GET(request(), { params: Promise.resolve({ jobId: JOB_ID }) });
    const payload = await response.json();

    expect(payload.sources).toEqual([expect.objectContaining({
      title: 'Legacy evidence',
      href: 'https://legacy.example/report',
    })]);
    expect(payload.artifact.content).toContain('[原始证据](https://legacy.example/report)');
  });

  it('recovers a draft by upstream id when the terminal poll races the draft relation commit', async () => {
    mocks.jobFindUnique.mockResolvedValue({
      requesterId: USER_ID,
      context: null,
      sourceRefs: [],
      brief: null,
      conversation: [],
      updatedAt: new Date('2026-09-01T00:00:00Z'),
      draftResearch: null,
      aiResearchSources: [],
    });
    mocks.researchFindUnique.mockResolvedValue({
      title: '结论',
      body: '# 结论\n\n草稿已提交。',
      audit: [],
    });

    const response = await GET(request(), { params: Promise.resolve({ jobId: JOB_ID }) });
    const payload = await response.json();

    expect(mocks.researchFindUnique).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: '33333333-3333-4333-8333-333333333333' },
    }));
    expect(payload.artifact).toMatchObject({
      title: '结论',
      content: '# 结论\n\n草稿已提交。',
    });
  });

  it('downgrades a legacy evidence digest instead of presenting it as a report', async () => {
    mocks.jobFindUnique.mockResolvedValue({
      requesterId: USER_ID,
      context: null,
      sourceRefs: [],
      brief: null,
      conversation: [],
      partialSources: [],
      updatedAt: new Date('2026-09-01T00:00:00Z'),
      draftResearch: null,
      aiResearchSources: [],
    });
    mocks.fetchAiEngine.mockResolvedValue({
      ok: true,
      status: 200,
      body: {
        job_id: JOB_ID,
        status: 'stored',
        final_status: 'succeeded',
        report_type: 'research_report',
        topic: 'GraphRAG 选型',
        output_text: '> 报告模型没有返回可发布的研究正文。\n\n- 研究结论：待补写',
        draft_research_id: null,
        sources_count: 0,
        review: { phase: 'completed', status: 'needs_revision' },
      },
    });

    const response = await GET(request(), { params: Promise.resolve({ jobId: JOB_ID }) });
    const payload = await response.json();

    expect(payload.finalStatus).toBe('partial');
    expect(payload.deliverableStatus).toBe('evidence_only');
    expect(payload.review).toBeNull();
    expect(payload.artifact.content).toContain('研究结论：待补写');
  });

  it('builds a read-only evidence snapshot when a run saved bodies but no report', async () => {
    mocks.jobFindUnique.mockResolvedValue({
      requesterId: USER_ID,
      context: null,
      sourceRefs: [],
      brief: null,
      conversation: [],
      partialSources: [],
      updatedAt: new Date('2026-09-03T00:00:00Z'),
      draftResearch: null,
      aiResearchSources: [{
        id: '55555555-5555-4555-8555-555555555555',
        title: 'Saved source',
        snippet: 'A captured paragraph that can be checked by the reader.',
        score: 0.9,
        sourceRef: { type: 'url', value: 'https://example.com/saved' },
        canonicalKey: 'https://example.com/saved',
        stepCaptured: 'search',
        createdAt: new Date('2026-09-03T00:00:00Z'),
      }],
      _count: { aiResearchSources: 1 },
    });
    mocks.fetchAiEngine.mockResolvedValue({
      ok: true,
      status: 200,
      body: {
        job_id: JOB_ID,
        status: 'stored',
        final_status: 'partial',
        report_type: 'research_report',
        topic: 'GraphRAG 选型',
        output_text: '',
        draft_research_id: null,
        sources_count: 1,
      },
    });

    const response = await GET(request(), { params: Promise.resolve({ jobId: JOB_ID }) });
    const payload = await response.json();

    expect(payload.deliverableStatus).toBe('evidence_only');
    expect(payload.artifact.title).toContain('资料快照');
    expect(payload.artifact.content).toContain('A captured paragraph that can be checked by the reader.');
    expect(payload.finalStatus).toBe('partial');
  });
});
