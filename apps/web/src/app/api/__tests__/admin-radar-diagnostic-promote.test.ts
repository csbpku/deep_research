import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  requireAdmin: vi.fn(),
  diagnosticFind: vi.fn(),
  diagnosticUpdate: vi.fn(),
  summaryFind: vi.fn(),
  summaryCreate: vi.fn(),
  summaryUpdate: vi.fn(),
  writeAdminAction: vi.fn(),
  forwardAction: vi.fn(),
}));

vi.mock('@/lib/auth/session', () => ({ requireAdmin: mocks.requireAdmin }));
vi.mock('@/lib/admin-radar-action', () => ({ forwardAdminRadarAction: mocks.forwardAction }));
vi.mock('@/lib/radar/runtime-flags', () => ({ radarEnrichmentEnabled: () => false }));
vi.mock('@/lib/radar/admin-actions', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/radar/admin-actions')>()),
  newAdminActionRequestId: () => 'test-request',
  writeAdminAction: mocks.writeAdminAction,
}));
vi.mock('@/lib/db', () => {
  const tx = {
    radarSyncDiagnostic: { findUnique: mocks.diagnosticFind, update: mocks.diagnosticUpdate },
    summary: { findUnique: mocks.summaryFind, create: mocks.summaryCreate, update: mocks.summaryUpdate },
  };
  return { prisma: { $transaction: async (callback: (value: unknown) => Promise<unknown>) => callback(tx) } };
});

import { POST } from '../admin/radar/diagnostics/[id]/promote/route';

const context = { params: Promise.resolve({ id: 'diagnostic-1' }) };
const request = () => new Request('http://localhost/api/admin/radar/diagnostics/diagnostic-1/promote', {
  method: 'POST',
}) as never;

beforeEach(() => {
  vi.resetAllMocks();
  mocks.requireAdmin.mockResolvedValue({ id: 'admin', role: 'admin' });
});

describe('admin radar diagnostic promotion', () => {
  it.each(['SOURCE_FEED_EXCERPT', 'SOURCE_EXCERPT_NOISE_PENDING', 'MODEL_QUOTA_STOPPED'])(
    'rejects the incomplete-evidence diagnostic %s before modifying a candidate',
    async (reasonCode) => {
      mocks.diagnosticFind.mockResolvedValue({ kind: 'filtered', status: 'pending', reasonCode });
      const response = await POST(request(), context);
      expect(response.status).toBe(400);
      expect(mocks.summaryFind).not.toHaveBeenCalled();
      expect(mocks.summaryCreate).not.toHaveBeenCalled();
      expect(mocks.summaryUpdate).not.toHaveBeenCalled();
      expect(mocks.diagnosticUpdate).not.toHaveBeenCalled();
      expect(mocks.writeAdminAction).not.toHaveBeenCalled();
      expect(mocks.forwardAction).not.toHaveBeenCalled();
    },
  );

  it('keeps ordinary filtered diagnostics promotable', async () => {
    mocks.diagnosticFind.mockResolvedValue({
      kind: 'filtered', status: 'pending', reasonCode: 'RULE_NOISE',
      canonicalUrl: 'https://example.com/article', runId: 'run-1',
    });
    mocks.summaryFind.mockResolvedValue({ id: 'summary-1', tags: [] });
    mocks.diagnosticUpdate.mockResolvedValue({ id: 'diagnostic-1', status: 'promoted', promotedSummaryId: 'summary-1' });
    const response = await POST(request(), context);
    expect(response.status).toBe(200);
    expect(mocks.summaryUpdate).toHaveBeenCalledOnce();
    expect(mocks.diagnosticUpdate).toHaveBeenCalledOnce();
    expect(mocks.writeAdminAction).toHaveBeenCalledOnce();
  });
});
