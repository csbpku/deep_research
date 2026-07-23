// BFF handler: POST /api/imports — 创建文件导入任务
//               GET  /api/imports — 查询用户导入任务列表
//
// 契约源：
//   - apps/web/prisma/schema.prisma: ContentImportJob
//   - docs/contracts/state-machines.md §3: ImportStatus
//   - 验收: 可看到 queued/running/succeeded/failed；成功后查看 warnings 和私有草稿
//
// POST: multipart/form-data → 校验 MIME/大小/UTF-8 → SHA-256 去重 → 创建 job
// GET:  返回当前用户的导入任务列表

import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import path from 'node:path';
import fs from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { prisma } from '../../../lib/db';
import { apiHandler } from '../../../lib/api-handler';
import { requireUser } from '../../../lib/auth/session';
import { toApiErrorResponse } from '../../../lib/errors';
import { log, withRequestId } from '../../../lib/log';
import { CreateImportInput } from '../../../lib/schemas';
import { ERROR_CODES } from '@deep-research/shared/errors';
import { IMPORT_STATUS } from '@deep-research/shared/states';

const MAX_FILE_BYTES = 5 * 1024 * 1024; // 5MB

export const POST = apiHandler<[NextRequest]>(async (req) => {
  const requestId = withRequestId(req.headers);
  const u = await requireUser(req);
  if (u instanceof NextResponse) return u;

  // ── Parse multipart form ─────────────────────────────────────────────
  const contentType = req.headers.get('content-type') ?? '';
  if (!contentType.includes('multipart/form-data')) {
    return toApiErrorResponse({
      code: ERROR_CODES.VALIDATION_FAILED,
      message: 'Content-Type 必须为 multipart/form-data',
      requestId,
    });
  }

  let formData: FormData;
  try {
    formData = await req.formData();
  } catch {
    return toApiErrorResponse({
      code: ERROR_CODES.VALIDATION_FAILED,
      message: '无法解析 form data',
      requestId,
    });
  }

  const file = formData.get('file');
  if (!file || !(file instanceof File)) {
    return toApiErrorResponse({
      code: ERROR_CODES.VALIDATION_FAILED,
      message: '请上传文件',
      requestId,
    });
  }

  const filename = file.name || 'untitled';
  // W2/W3 review 修正: 效验扩展名 — 仅允许 .md .txt .html
  const ext = filename.lastIndexOf('.') >= 0
    ? filename.slice(filename.lastIndexOf('.')).toLowerCase()
    : '';
  const ALLOWED_EXTENSIONS: Record<string, string> = {
    '.md': 'text/markdown',
    '.txt': 'text/plain',
    '.html': 'text/html',
  };
  if (!ALLOWED_EXTENSIONS[ext]) {
    return toApiErrorResponse({
      code: ERROR_CODES.IMPORT_INVALID_MIME,
      message: `不支持的文件后缀: ${ext || '(无)'}。仅允许 .md / .txt / .html`,
      requestId,
    });
  }
  const effectiveMime = ALLOWED_EXTENSIONS[ext];
  const suppliedMime = file.type.trim().toLowerCase();
  if (suppliedMime && suppliedMime !== effectiveMime) {
    return toApiErrorResponse({
      code: ERROR_CODES.IMPORT_INVALID_MIME,
      message: `文件后缀 ${ext} 与 MIME ${suppliedMime} 不匹配`,
      requestId,
    });
  }
  const mimeType = effectiveMime;
  const sizeBytes = file.size;

  if (sizeBytes > MAX_FILE_BYTES) {
    return toApiErrorResponse({
      code: ERROR_CODES.IMPORT_FILE_TOO_LARGE,
      message: '文件超过 5MB 限制',
      requestId,
    });
  }

  // ── Validate metadata ────────────────────────────────────────────────
  const metaResult = CreateImportInput.safeParse({ filename, mimeType, sizeBytes });
  if (!metaResult.success) {
    return toApiErrorResponse({
      code: ERROR_CODES.VALIDATION_FAILED,
      message: '文件参数不合法',
      requestId,
      details: metaResult.error.flatten(),
    });
  }

  // ── Read content & validate ─────────────────────────────────────────
  let buffer: ArrayBuffer;
  try {
    buffer = await file.arrayBuffer();
  } catch {
    return toApiErrorResponse({
      code: ERROR_CODES.INTERNAL,
      message: '读取文件失败',
      requestId,
    });
  }

  if (buffer.byteLength > MAX_FILE_BYTES) {
    return toApiErrorResponse({
      code: ERROR_CODES.IMPORT_FILE_TOO_LARGE,
      message: '文件超过 5MB 限制',
      requestId,
    });
  }

  // UTF-8 校验
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let contentStr: string;
  try {
    contentStr = decoder.decode(new Uint8Array(buffer));
  } catch {
    return toApiErrorResponse({
      code: ERROR_CODES.IMPORT_NOT_UTF8,
      message: '文件不是有效的 UTF-8 文本',
      requestId,
    });
  }

  // HTML is stored as untrusted text. The import worker parses and sanitizes
  // it before creating a Markdown draft; the raw file is never rendered.
  const warnings: string[] = [];

  // SHA-256 去重
  const sha256 = createHash('sha256').update(contentStr, 'utf-8').digest('hex');

  // 保存文件到临时目录(tempObjectKey 记录路径),worker 拿到真文件。
  const tempDir = path.join(process.cwd(), 'data', 'import-tmp');
  await fs.mkdir(tempDir, { recursive: true });
  const tempKey = `${randomUUID()}${ext}`;
  const tempPath = path.join(tempDir, tempKey);
  await fs.writeFile(tempPath, contentStr, 'utf-8');

  // W2/W3 review 修正: 用 INSERT 遇到唯一约束(并发同 SHA-256)时 catch P2002,
  // 清理 temp 文件并返回已有 job id(不是 500)。避免 findFirst+create race。
  let job: { id: string; status: string; originalFilename: string | null; mimeType: string | null; sizeBytes: bigint | null; contentSha256: string | null; warnings: unknown; createdAt: Date };
  let duplicate = false;
  try {
    job = await prisma.contentImportJob.create({
      data: {
        requesterId: u.id,
        sourceKind: 'file',
        status: IMPORT_STATUS.QUEUED,
        originalFilename: filename,
        mimeType,
        sizeBytes: BigInt(sizeBytes),
        contentSha256: sha256,
        converterVersion: '1.0.0',
        tempObjectKey: tempKey,
        warnings: warnings.length > 0 ? warnings : [],
      },
      select: {
        id: true, status: true, originalFilename: true, mimeType: true,
        sizeBytes: true, contentSha256: true, warnings: true, createdAt: true,
      },
    });
  } catch (err: unknown) {
    if ((err as { code?: string })?.code === 'P2002') {
      const dup = await prisma.contentImportJob.findFirst({
        where: {
          requesterId: u.id,
          contentSha256: sha256,
          status: { in: [IMPORT_STATUS.QUEUED, IMPORT_STATUS.RUNNING, IMPORT_STATUS.SUCCEEDED] },
        },
        select: {
          id: true, status: true, originalFilename: true, mimeType: true,
          sizeBytes: true, contentSha256: true, warnings: true, createdAt: true,
        },
      });
      if (dup) {
        await fs.unlink(tempPath).catch(() => {});
        return NextResponse.json({
          jobId: dup.id, status: dup.status, duplicate: true,
          message: '相同文件已存在导入任务',
        }, { status: 200 });
      }
    }
    await fs.unlink(tempPath).catch(() => {});
    throw err;
  }

  log.info('import.create', 'job created', {
    requestId,
    userId: u.id,
    jobId: job.id,
    contentSha256: sha256,
    hasWarnings: warnings.length > 0,
  });

  return NextResponse.json(
    {
      jobId: job.id,
      status: job.status,
      duplicate: false,
      filename: job.originalFilename,
      mimeType: job.mimeType,
      sizeBytes: job.sizeBytes ? Number(job.sizeBytes) : null,
      hasWarnings: warnings.length > 0,
    },
    { status: 201 },
  );
});

// ─── GET /api/imports ─────────────────────────────────────────────────

export const GET = apiHandler<[NextRequest]>(async (req) => {
  const requestId = withRequestId(req.headers);
  const u = await requireUser(req);
  if (u instanceof NextResponse) return u;

  const url = new URL(req.url);
  const page = Math.max(1, parseInt(url.searchParams.get('page') ?? '1', 10) || 1);
  const limit = Math.min(50, Math.max(1, parseInt(url.searchParams.get('limit') ?? '20', 10) || 20));

  const [items, total] = await Promise.all([
    prisma.contentImportJob.findMany({
      where: { requesterId: u.id },
      orderBy: { createdAt: 'desc' },
      skip: (page - 1) * limit,
      take: limit,
      select: {
        id: true,
        status: true,
        originalFilename: true,
        mimeType: true,
        sizeBytes: true,
        contentSha256: true,
        warnings: true,
        errorCode: true,
        errorMessage: true,
        outputResearchId: true,
        createdAt: true,
        completedAt: true,
      },
    }),
    prisma.contentImportJob.count({ where: { requesterId: u.id } }),
  ]);

  return NextResponse.json({
    items: items.map((j) => ({
      jobId: j.id,
      status: j.status,
      filename: j.originalFilename,
      mimeType: j.mimeType,
      sizeBytes: j.sizeBytes ? Number(j.sizeBytes) : null,
      warnings: j.warnings,
      errorCode: j.errorCode,
      errorMessage: j.errorMessage,
      outputResearchId: j.outputResearchId,
      createdAt: j.createdAt.toISOString(),
      completedAt: j.completedAt?.toISOString() ?? null,
    })),
    page,
    limit,
    total,
    totalPages: Math.ceil(total / limit),
  });
});
