// Unit tests: Admin 调研库管理 BFF routes.
//
// 覆盖：
//   - GET /api/admin/researches：admin-only、状态/类型/关键词筛选、分页
//   - POST /api/admin/researches/[id]/archive：published → archived + 双审计
//   - POST /api/admin/researches/[id]/restore：archived → published + 双审计
//   - 非法状态转换返回 4xx 且不写审计

import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  requireAdmin: vi.fn(),
  requireUser: vi.fn(),
  researchFindUnique: vi.fn(),
  researchFindMany: vi.fn(),
  researchCount: vi.fn(),
  researchUpdate: vi.fn(),
  researchDelete: vi.fn(),
  aiJobDelete: vi.fn(),
  auditCreate: vi.fn(),
  adminActionCreate: vi.fn(),
  transaction: vi.fn(),
  randomUUID: vi.fn(),
}));

vi.mock('../../../lib/api-handler.js', async (importOriginal) => ({
  ...await importOriginal<typeof import('../../../lib/api-handler.js')>(),
  apiHandler: (handler: unknown) => handler,
}));
vi.mock('../../../lib/auth/session.js', () => ({
  requireAdmin: mocks.requireAdmin,
  requireUser: mocks.requireUser,
}));
vi.mock('../../../lib/db.js', () => ({
  prisma: {
    research: {
      findUnique: mocks.researchFindUnique,
      findMany: mocks.researchFindMany,
      count: mocks.researchCount,
      update: mocks.researchUpdate,
      delete: mocks.researchDelete,
    },
    aiResearchJob: { delete: mocks.aiJobDelete },
    researchAudit: { create: mocks.auditCreate },
    adminAction: { create: mocks.adminActionCreate },
    $transaction: mocks.transaction,
  },
}));
vi.mock('node:crypto', async (importOriginal) => ({
  ...await importOriginal<typeof import('node:crypto')>(),
  randomUUID: mocks.randomUUID,
}));

import { GET as adminResearchList } from '../admin/researches/route';
import { POST as adminArchive } from '../admin/researches/[id]/archive/route';
import { POST as adminRestore } from '../admin/researches/[id]/restore/route';
import { POST as adminFeature } from '../admin/researches/[id]/feature/route';
import { POST as adminUnfeature } from '../admin/researches/[id]/unfeature/route';
import { POST as ownerArchive } from '../researches/[id]/archive/route';
import { POST as ownerRestore } from '../researches/[id]/restore/route';
import {
  DELETE as researchDelete,
  PUT as researchUpdate,
} from '../researches/[id]/route';

const ADMIN = {
  id: '22222222-2222-4222-8222-222222222222',
  email: 'a@x.com',
  name: 'Admin',
  role: 'admin' as const,
};
const RESEARCH_ID = '33333333-3333-4333-8333-333333333333';
const AUTHOR_ID = '44444444-4444-4444-8444-444444444444';
const OWNER = {
  id: AUTHOR_ID,
  email: 'owner@x.com',
  name: 'Owner',
  role: 'member' as const,
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.requireAdmin.mockResolvedValue(ADMIN);
  mocks.requireUser.mockResolvedValue(ADMIN);
  mocks.randomUUID.mockReturnValue('00000000-0000-4000-8000-000000000001');
  mocks.researchFindMany.mockResolvedValue([]);
  mocks.researchCount.mockResolvedValue(0);
  mocks.researchDelete.mockResolvedValue({ id: RESEARCH_ID });
  mocks.researchUpdate.mockResolvedValue({
    id: RESEARCH_ID,
    status: 'archived',
    updatedAt: new Date('2026-08-06T00:00:00Z'),
  });
  mocks.auditCreate.mockResolvedValue({ id: 'audit-1' });
  mocks.adminActionCreate.mockResolvedValue({ id: 'action-1', requestId: 'req-1' });
  mocks.transaction.mockImplementation(async (callback: (tx: unknown) => Promise<unknown>) =>
    callback({
      research: { findUnique: mocks.researchFindUnique, update: mocks.researchUpdate, delete: mocks.researchDelete },
      aiResearchJob: { delete: mocks.aiJobDelete },
      researchAudit: { create: mocks.auditCreate },
      adminAction: { create: mocks.adminActionCreate },
    }),
  );
});

describe('GET /api/admin/researches', () => {
  it('returns 403 for non-admin callers', async () => {
    const { NextResponse } = await import('next/server');
    mocks.requireAdmin.mockResolvedValueOnce(NextResponse.json(
      { code: 'PERMISSION_DENIED', message: '需要管理员权限', requestId: 'r' },
      { status: 403 },
    ));

    const response = await adminResearchList(
      new Request('http://localhost/api/admin/researches') as never,
    );

    expect(response.status).toBe(403);
    expect(mocks.researchFindMany).not.toHaveBeenCalled();
  });

  it('lists research across all statuses and shapes dates for the client', async () => {
    mocks.researchFindMany.mockResolvedValue([{
      id: RESEARCH_ID,
      type: 'research',
      status: 'published',
      title: '平台增长复盘',
      body: '正文',
      tags: ['增长'],
      authorId: AUTHOR_ID,
      creationMethod: 'manual',
      aiAssisted: false,
      publishedAt: new Date('2026-08-01T00:00:00Z'),
      featuredAt: null,
      createdAt: new Date('2026-07-30T00:00:00Z'),
      updatedAt: new Date('2026-08-01T00:00:00Z'),
      author: { id: AUTHOR_ID, name: '作者 A' },
    }]);
    mocks.researchCount.mockResolvedValue(1);

    const response = await adminResearchList(
      new Request('http://localhost/api/admin/researches?status=all') as never,
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.total).toBe(1);
    expect(body.items[0]).toMatchObject({
      id: RESEARCH_ID,
      status: 'published',
      author: { id: AUTHOR_ID, name: '作者 A' },
    });
    expect(body.items[0].publishedAt).toBe('2026-08-01T00:00:00.000Z');
    expect(body.items[0].featuredAt).toBeNull();
  });

  it('passes status/type/keyword filters and pagination to Prisma', async () => {
    await adminResearchList(
      new Request(
        'http://localhost/api/admin/researches?status=draft&type=knowledge&q=向量&page=2&limit=10',
      ) as never,
    );

    expect(mocks.researchFindMany).toHaveBeenCalledWith(expect.objectContaining({
      where: {
        AND: [
          { status: { equals: 'draft' } },
          { type: { equals: 'knowledge' } },
          {
            OR: [
              { title: { contains: '向量', mode: 'insensitive' } },
              { body: { contains: '向量', mode: 'insensitive' } },
              { tags: { has: '向量' } },
            ],
          },
        ],
      },
      skip: 10,
      take: 10,
    }));
  });
});

describe('POST /api/admin/researches/[id]/archive', () => {
  it('archives a published research and writes both audit trails', async () => {
    mocks.researchFindUnique.mockResolvedValue({
      id: RESEARCH_ID,
      status: 'published',
    });

    const response = await adminArchive(
      new Request('http://localhost/x', { method: 'POST' }) as never,
      { params: Promise.resolve({ id: RESEARCH_ID }) },
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.research.status).toBe('archived');
    expect(mocks.researchUpdate).toHaveBeenCalledWith({
      where: { id: RESEARCH_ID },
      data: { status: 'archived' },
      select: { id: true, status: true, updatedAt: true },
    });
    expect(mocks.auditCreate).toHaveBeenCalledWith({
      data: { researchId: RESEARCH_ID, editorId: ADMIN.id, action: 'archive' },
    });
    expect(mocks.adminActionCreate).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        actorId: ADMIN.id,
        action: 'research_archive',
        targetType: 'research',
        targetId: RESEARCH_ID,
      }),
    }));
  });

  it('rejects archiving a draft without writing any audit', async () => {
    mocks.researchFindUnique.mockResolvedValue({
      id: RESEARCH_ID,
      status: 'draft',
    });

    const response = await adminArchive(
      new Request('http://localhost/x', { method: 'POST' }) as never,
      { params: Promise.resolve({ id: RESEARCH_ID }) },
    );

    expect(response.status).toBe(400);
    expect(mocks.transaction).not.toHaveBeenCalled();
  });
});

describe('POST /api/admin/researches/[id]/restore', () => {
  it('restores an archived research and keeps publishedAt', async () => {
    mocks.researchFindUnique.mockResolvedValue({
      id: RESEARCH_ID,
      status: 'archived',
      publishedAt: new Date('2026-08-01T00:00:00Z'),
    });
    mocks.researchUpdate.mockResolvedValue({
      id: RESEARCH_ID,
      status: 'published',
      updatedAt: new Date('2026-08-06T00:00:00Z'),
    });

    const response = await adminRestore(
      new Request('http://localhost/x', { method: 'POST' }) as never,
      { params: Promise.resolve({ id: RESEARCH_ID }) },
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.research.status).toBe('published');
    expect(mocks.researchUpdate).toHaveBeenCalledWith({
      where: { id: RESEARCH_ID },
      data: {
        status: 'published',
        publishedAt: new Date('2026-08-01T00:00:00Z'),
      },
      select: { id: true, status: true, updatedAt: true },
    });
    expect(mocks.auditCreate).toHaveBeenCalledWith({
      data: { researchId: RESEARCH_ID, editorId: ADMIN.id, action: 'restore' },
    });
    expect(mocks.adminActionCreate).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        actorId: ADMIN.id,
        action: 'research_restore',
        targetType: 'research',
        targetId: RESEARCH_ID,
      }),
    }));
  });

  it('rejects restoring a published research', async () => {
    mocks.researchFindUnique.mockResolvedValue({
      id: RESEARCH_ID,
      status: 'published',
      publishedAt: new Date('2026-08-01T00:00:00Z'),
    });

    const response = await adminRestore(
      new Request('http://localhost/x', { method: 'POST' }) as never,
      { params: Promise.resolve({ id: RESEARCH_ID }) },
    );

    expect(response.status).toBe(400);
    expect(mocks.transaction).not.toHaveBeenCalled();
  });
});

describe('POST /api/admin/researches/[id]/feature', () => {
  it('features a published research and writes both audit trails', async () => {
    mocks.researchFindUnique.mockResolvedValue({
      id: RESEARCH_ID,
      status: 'published',
      featuredAt: null,
    });
    mocks.researchUpdate.mockResolvedValue({
      id: RESEARCH_ID,
      featuredAt: new Date('2026-08-06T01:00:00Z'),
      updatedAt: new Date('2026-08-06T01:00:00Z'),
    });

    const response = await adminFeature(
      new Request('http://localhost/x', { method: 'POST' }) as never,
      { params: Promise.resolve({ id: RESEARCH_ID }) },
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.research.featuredAt).toBe('2026-08-06T01:00:00.000Z');
    expect(mocks.researchUpdate).toHaveBeenCalledWith({
      where: { id: RESEARCH_ID },
      data: { featuredAt: expect.any(Date) },
      select: { id: true, featuredAt: true, updatedAt: true },
    });
    expect(mocks.auditCreate).toHaveBeenCalledWith({
      data: { researchId: RESEARCH_ID, editorId: ADMIN.id, action: 'feature' },
    });
    expect(mocks.adminActionCreate).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        actorId: ADMIN.id,
        action: 'research_feature',
        targetType: 'research',
        targetId: RESEARCH_ID,
        metadata: { featured: true },
      }),
    }));
  });

  it('rejects featuring a draft or an already featured research', async () => {
    mocks.researchFindUnique.mockResolvedValue({
      id: RESEARCH_ID,
      status: 'draft',
      featuredAt: null,
    });

    const response = await adminFeature(
      new Request('http://localhost/x', { method: 'POST' }) as never,
      { params: Promise.resolve({ id: RESEARCH_ID }) },
    );

    expect(response.status).toBe(400);
    expect(mocks.transaction).not.toHaveBeenCalled();
  });
});

describe('POST /api/admin/researches/[id]/unfeature', () => {
  it('removes the featured flag and writes both audit trails', async () => {
    mocks.researchFindUnique.mockResolvedValue({
      id: RESEARCH_ID,
      status: 'published',
      featuredAt: new Date('2026-08-06T01:00:00Z'),
    });
    mocks.researchUpdate.mockResolvedValue({
      id: RESEARCH_ID,
      featuredAt: null,
      updatedAt: new Date('2026-08-06T02:00:00Z'),
    });

    const response = await adminUnfeature(
      new Request('http://localhost/x', { method: 'POST' }) as never,
      { params: Promise.resolve({ id: RESEARCH_ID }) },
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.research.featuredAt).toBeNull();
    expect(mocks.researchUpdate).toHaveBeenCalledWith({
      where: { id: RESEARCH_ID },
      data: { featuredAt: null },
      select: { id: true, featuredAt: true, updatedAt: true },
    });
    expect(mocks.auditCreate).toHaveBeenCalledWith({
      data: { researchId: RESEARCH_ID, editorId: ADMIN.id, action: 'unfeature' },
    });
    expect(mocks.adminActionCreate).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        actorId: ADMIN.id,
        action: 'research_unfeature',
        targetType: 'research',
        targetId: RESEARCH_ID,
        metadata: { featured: false },
      }),
    }));
  });
});

describe('POST /api/researches/[id]/archive and restore for owner', () => {
  it('lets the owner archive their own published research', async () => {
    mocks.requireUser.mockResolvedValue(OWNER);
    mocks.researchFindUnique.mockResolvedValue({
      id: RESEARCH_ID,
      authorId: OWNER.id,
      status: 'published',
    });

    const response = await ownerArchive(
      new Request('http://localhost/x', { method: 'POST' }) as never,
      { params: Promise.resolve({ id: RESEARCH_ID }) },
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.research.status).toBe('archived');
    expect(mocks.researchUpdate).toHaveBeenCalledWith({
      where: { id: RESEARCH_ID },
      data: { status: 'archived' },
      select: { id: true, status: true, updatedAt: true },
    });
    expect(mocks.auditCreate).toHaveBeenCalledWith({
      data: { researchId: RESEARCH_ID, editorId: OWNER.id, action: 'archive' },
    });
    expect(mocks.adminActionCreate).not.toHaveBeenCalled();
  });

  it('lets the owner restore their own archived research', async () => {
    mocks.requireUser.mockResolvedValue(OWNER);
    mocks.researchFindUnique.mockResolvedValue({
      id: RESEARCH_ID,
      authorId: OWNER.id,
      status: 'archived',
      publishedAt: new Date('2026-08-01T00:00:00Z'),
    });
    mocks.researchUpdate.mockResolvedValue({
      id: RESEARCH_ID,
      status: 'published',
      updatedAt: new Date('2026-08-06T00:00:00Z'),
    });

    const response = await ownerRestore(
      new Request('http://localhost/x', { method: 'POST' }) as never,
      { params: Promise.resolve({ id: RESEARCH_ID }) },
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.research.status).toBe('published');
    expect(mocks.auditCreate).toHaveBeenCalledWith({
      data: { researchId: RESEARCH_ID, editorId: OWNER.id, action: 'restore' },
    });
    expect(mocks.adminActionCreate).not.toHaveBeenCalled();
  });

  it('rejects a non-owner archive request', async () => {
    mocks.requireUser.mockResolvedValue({
      ...OWNER,
      id: '55555555-5555-4555-8555-555555555555',
    });
    mocks.researchFindUnique.mockResolvedValue({
      id: RESEARCH_ID,
      authorId: OWNER.id,
      status: 'published',
    });

    const response = await ownerArchive(
      new Request('http://localhost/x', { method: 'POST' }) as never,
      { params: Promise.resolve({ id: RESEARCH_ID }) },
    );

    expect(response.status).toBe(403);
    expect(mocks.transaction).not.toHaveBeenCalled();
  });
});

describe('DELETE /api/researches/[id] for admin', () => {
  it('rejects an admin deleting another user\'s draft', async () => {
    mocks.researchFindUnique.mockResolvedValue({
      id: RESEARCH_ID,
      authorId: AUTHOR_ID,
      status: 'draft',
      sourceAiJob: null,
    });

    const response = await researchDelete(
      new Request(`http://localhost/api/researches/${RESEARCH_ID}`, { method: 'DELETE' }) as never,
      { params: Promise.resolve({ id: RESEARCH_ID }) },
    );
    const body = await response.json();

    expect(response.status).toBe(403);
    expect(body.code).toBe('PERMISSION_DENIED');
    expect(mocks.researchDelete).not.toHaveBeenCalled();
    expect(mocks.adminActionCreate).not.toHaveBeenCalled();
  });

  it('still hides drafts from a non-owner member', async () => {
    mocks.requireUser.mockResolvedValue({ ...ADMIN, id: '55555555-5555-4555-8555-555555555555', role: 'member' });
    mocks.researchFindUnique.mockResolvedValue({
      id: RESEARCH_ID,
      authorId: AUTHOR_ID,
      status: 'draft',
      sourceAiJob: null,
    });

    const response = await researchDelete(
      new Request(`http://localhost/api/researches/${RESEARCH_ID}`, { method: 'DELETE' }) as never,
      { params: Promise.resolve({ id: RESEARCH_ID }) },
    );

    expect(response.status).toBe(404);
    expect(mocks.transaction).not.toHaveBeenCalled();
  });
});

describe('PUT /api/researches/[id] for admin', () => {
  it('rejects editing another user\'s draft', async () => {
    mocks.requireUser.mockResolvedValue(ADMIN);
    mocks.researchFindUnique.mockResolvedValue({
      id: RESEARCH_ID,
      authorId: AUTHOR_ID,
      status: 'draft',
    });

    const response = await researchUpdate(
      new Request(`http://localhost/api/researches/${RESEARCH_ID}`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ title: '改别人的草稿' }),
      }) as never,
      { params: Promise.resolve({ id: RESEARCH_ID }) },
    );

    expect(response.status).toBe(403);
    expect(mocks.researchUpdate).not.toHaveBeenCalled();
  });

  it('allows editing another user\'s published research', async () => {
    mocks.requireUser.mockResolvedValue(ADMIN);
    mocks.researchFindUnique.mockResolvedValue({
      id: RESEARCH_ID,
      authorId: AUTHOR_ID,
      status: 'published',
      title: 'Old title',
      body: 'Body',
      background: null,
      conclusion: null,
      risks: null,
      tags: [],
      creationMethod: 'manual',
      aiAssisted: false,
    });
    mocks.researchUpdate.mockResolvedValue({
      id: RESEARCH_ID,
      type: 'research',
      status: 'published',
      title: 'New title',
      body: 'Body',
      background: null,
      conclusion: null,
      risks: null,
      tags: [],
      authorId: AUTHOR_ID,
      creationMethod: 'manual',
      aiAssisted: false,
      originContentSha256: null,
      reviewStatus: null,
      reviewAttempts: 0,
      reviewSummary: null,
      reviewClaims: null,
      reviewedAt: null,
      reviewDetails: null,
      sourceCommentId: null,
      publishedAt: new Date('2026-08-01T00:00:00Z'),
      featuredAt: null,
      createdAt: new Date('2026-07-30T00:00:00Z'),
      updatedAt: new Date('2026-08-06T00:00:00Z'),
      author: { id: AUTHOR_ID, name: 'Owner', email: 'owner@x.com' },
      _count: { comments: 0 },
    });
    mocks.transaction.mockImplementation(async (callback: (tx: unknown) => Promise<unknown>) =>
      callback({
        research: { update: mocks.researchUpdate },
        researchAudit: { create: mocks.auditCreate },
      }),
    );

    const response = await researchUpdate(
      new Request(`http://localhost/api/researches/${RESEARCH_ID}`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ title: 'New title' }),
      }) as never,
      { params: Promise.resolve({ id: RESEARCH_ID }) },
    );

    expect(response.status).toBe(200);
    expect(mocks.researchUpdate).toHaveBeenCalled();
    expect(mocks.auditCreate).toHaveBeenCalled();
  });
});
