import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';

const mocks = vi.hoisted(() => ({
  create: vi.fn(),
  findFirst: vi.fn(),
  mkdir: vi.fn(),
  writeFile: vi.fn(),
  unlink: vi.fn(),
  transaction: vi.fn(),
  researchCreate: vi.fn(),
  researchFindUnique: vi.fn(),
  researchUpdate: vi.fn(),
  auditCreate: vi.fn(),
  eventCreate: vi.fn(),
}));

vi.mock('../../../lib/api-handler.js', async (importOriginal) => ({
  ...await importOriginal<typeof import('../../../lib/api-handler.js')>(),
  apiHandler: (handler: unknown) => handler,
}));
vi.mock('../../../lib/auth/session.js', () => ({
  requireUser: vi.fn().mockResolvedValue({ id: '11111111-1111-1111-1111-111111111111' }),
}));
vi.mock('../../../lib/db.js', () => ({
  prisma: {
    contentImportJob: {
      create: mocks.create,
      findFirst: mocks.findFirst,
    },
    research: { findUnique: mocks.researchFindUnique },
    $transaction: mocks.transaction,
  },
}));
vi.mock('node:fs/promises', () => ({
  default: { mkdir: mocks.mkdir, writeFile: mocks.writeFile, unlink: mocks.unlink },
}));

import { POST as importPost } from '../imports/route';
import { POST as researchPost } from '../researches/route';
import { POST as publishPost } from '../researches/[id]/publish/route';
import { CreateResearchInput } from '../../../lib/schemas';

function request(content: string, filename: string, mimeType: string): Request {
  const form = new FormData();
  form.set('file', new Blob([content], { type: mimeType }), filename);
  return new Request('http://localhost/api/imports', { method: 'POST', body: form });
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.mkdir.mockResolvedValue(undefined);
  mocks.writeFile.mockResolvedValue(undefined);
  mocks.unlink.mockResolvedValue(undefined);
  mocks.transaction.mockImplementation((callback) => callback({
    research: { create: mocks.researchCreate, update: mocks.researchUpdate },
    researchAudit: { create: mocks.auditCreate },
    productEvent: { create: mocks.eventCreate },
  }));
  mocks.create.mockResolvedValue({
    id: 'job-1',
    status: 'queued',
    originalFilename: 'notes.html',
    mimeType: 'text/html',
    sizeBytes: 12n,
    contentSha256: 'a'.repeat(64),
    warnings: [],
    createdAt: new Date(),
  });
});

describe('POST /api/imports', () => {
  it('rejects an extension and MIME mismatch before writing a temp file', async () => {
    const response = await importPost(request('hello', 'notes.html', 'text/plain') as never);
    expect(response.status).toBe(415);
    expect((await response.json()).code).toBe('IMPORT_INVALID_MIME');
    expect(mocks.writeFile).not.toHaveBeenCalled();
    expect(mocks.create).not.toHaveBeenCalled();
  });

  it('returns the dedicated payload-too-large error before reading the file', async () => {
    const response = await importPost(request(
      'x'.repeat(5 * 1024 * 1024 + 1), 'large.txt', 'text/plain',
    ) as never);
    expect(response.status).toBe(413);
    expect((await response.json()).code).toBe('IMPORT_FILE_TOO_LARGE');
    expect(mocks.writeFile).not.toHaveBeenCalled();
  });

  it('stores untrusted HTML under an opaque key for worker-side conversion', async () => {
    const html = '<p onclick="run()">Hello</p><script>bad()</script>';
    const response = await importPost(request(html, 'notes.html', 'text/html') as never);
    const payload = await response.json();

    expect(response.status).toBe(201);
    expect(payload).toMatchObject({ jobId: 'job-1', duplicate: false, mimeType: 'text/html' });
    expect(payload).not.toHaveProperty('tempObjectKey');
    expect(mocks.writeFile).toHaveBeenCalledWith(
      expect.stringMatching(/[0-9a-f-]{36}\.html$/), html, 'utf-8',
    );
    const createInput = mocks.create.mock.calls[0][0];
    expect(createInput.data.tempObjectKey).toMatch(/^[0-9a-f-]{36}\.html$/);
    expect(createInput.data.requesterId).toBe('11111111-1111-1111-1111-111111111111');
  });

  it('returns the active job and removes the extra upload on a unique conflict', async () => {
    mocks.create.mockRejectedValue({ code: 'P2002' });
    mocks.findFirst.mockResolvedValue({ id: 'existing', status: 'running' });

    const response = await importPost(request('same', 'same.md', 'text/markdown') as never);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ jobId: 'existing', duplicate: true });
    expect(mocks.findFirst).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ status: { in: ['queued', 'running', 'succeeded'] } }),
    }));
    expect(mocks.unlink).toHaveBeenCalledOnce();
  });
});

describe('research provenance input', () => {
  it('does not accept a client-controlled creationMethod', () => {
    const parsed = CreateResearchInput.safeParse({
      title: 'Manual draft',
      body: 'Body',
      creationMethod: 'ai_research',
    });
    expect(parsed.success).toBe(false);
  });

  it('forces manual provenance in the real create route', async () => {
    const now = new Date();
    mocks.researchCreate.mockResolvedValue({
      id: 'research-1', type: 'research', status: 'draft', title: 'Manual draft',
      body: 'Body', background: null, conclusion: null, risks: null, tags: [],
      authorId: '11111111-1111-1111-1111-111111111111', creationMethod: 'manual',
      aiAssisted: false, publishedAt: null, createdAt: now, updatedAt: now,
      author: { id: '11111111-1111-1111-1111-111111111111', name: 'User', email: 'u@test' },
    });
    const req = new Request('http://localhost/api/researches', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: 'Manual draft', body: 'Body' }),
    });

    const response = await researchPost(req as never);
    expect(response.status).toBe(201);
    expect(mocks.researchCreate.mock.calls[0][0].data.creationMethod).toBe('manual');
    expect(mocks.auditCreate).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ action: 'create' }),
    }));
  });

  it.each([
    ['unchanged', 'AI output', false],
    ['edited', 'Owner edited output', true],
  ])('publishes %s AI content with expected provenance', async (_label, body, expected) => {
    const now = new Date();
    const origin = createHash('sha256').update('AI output').digest('hex');
    mocks.researchFindUnique.mockResolvedValue({
      id: '22222222-2222-2222-2222-222222222222',
      authorId: '11111111-1111-1111-1111-111111111111', status: 'draft',
      title: 'AI draft', body, creationMethod: 'ai_research', originContentSha256: origin,
    });
    mocks.researchUpdate.mockImplementation(({ data }) => Promise.resolve({
      id: '22222222-2222-2222-2222-222222222222', type: 'research',
      status: 'published', title: 'AI draft', body, background: null, conclusion: null,
      risks: null, tags: [], authorId: '11111111-1111-1111-1111-111111111111',
      creationMethod: 'ai_research', aiAssisted: data.aiAssisted,
      publishedAt: now, createdAt: now, updatedAt: now,
      author: { id: '11111111-1111-1111-1111-111111111111', name: 'User', email: 'u@test' },
    }));

    const response = await publishPost(
      new Request('http://localhost/api/researches/id/publish', { method: 'POST' }) as never,
      { params: Promise.resolve({ id: '22222222-2222-2222-2222-222222222222' }) },
    );
    expect(response.status).toBe(200);
    expect((await response.json()).aiAssisted).toBe(expected);
    expect(mocks.researchUpdate.mock.calls[0][0].data.aiAssisted).toBe(expected);
  });
});
