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
import { createHash } from 'node:crypto';
import { prisma } from '../../../lib/db.js';
import { apiHandler, parseBody } from '../../../lib/api-handler.js';
import { requireUser } from '../../../lib/auth/session.js';
import { toApiErrorResponse } from '../../../lib/errors.js';
import { log, withRequestId } from '../../../lib/log.js';
import { CreateImportInput } from '../../../lib/schemas.js';
import { ERROR_CODES } from '@deep-research/shared/errors';
import { IMPORT_STATUS } from '@deep-research/shared/states';

const ALLOWED_MIMES = new Set(['text/markdown', 'text/plain', 'text/html']);
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
  const mimeType = file.type || 'text/plain';
  const sizeBytes = file.size;

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

  // HTML 安全检查
  const warnings: string[] = [];

  if (mimeType === 'text/html') {
    const safetyResult = checkHtmlSafety(contentStr);
    if (!safetyResult.safe) {
      return toApiErrorResponse({
        code: ERROR_CODES.IMPORT_HTML_UNSAFE,
        message: safetyResult.reason ?? 'HTML 包含不安全内容',
        requestId,
      });
    }
    if (safetyResult.warnings.length > 0) {
      warnings.push(...safetyResult.warnings);
    }

    // 对 HTML 做清洗：移除 script/style/iframe/object 和事件属性
    contentStr = sanitizeHtml(contentStr);
  }

  // SHA-256 去重
  const sha256 = createHash('sha256').update(contentStr, 'utf-8').digest('hex');

  // 检查去重：同用户同 SHA-256 在 queued/running/succeeded 中唯一
  const existing = await prisma.contentImportJob.findFirst({
    where: {
      requesterId: u.id,
      contentSha256: sha256,
      status: { in: [IMPORT_STATUS.QUEUED, IMPORT_STATUS.RUNNING, IMPORT_STATUS.SUCCEEDED] },
    },
    select: { id: true, status: true },
  });

  if (existing) {
    return NextResponse.json(
      {
        jobId: existing.id,
        status: existing.status,
        duplicate: true,
        message: '相同文件已存在导入任务',
      },
      { status: 200 },
    );
  }

  // ── Create import job ────────────────────────────────────────────────
  const job = await prisma.contentImportJob.create({
    data: {
      requesterId: u.id,
      sourceKind: 'file',
      status: IMPORT_STATUS.QUEUED,
      originalFilename: filename,
      mimeType,
      sizeBytes: BigInt(sizeBytes),
      contentSha256: sha256,
      converterVersion: '1.0.0',
      warnings: warnings.length > 0 ? warnings : [],
    },
    select: {
      id: true,
      status: true,
      originalFilename: true,
      mimeType: true,
      sizeBytes: true,
      contentSha256: true,
      warnings: true,
      createdAt: true,
    },
  });

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

// ──────────────────────────────────────────────────────────────────────
// HTML 安全检查 + 清洗
// ──────────────────────────────────────────────────────────────────────

const DANGEROUS_TAG_RE = /<(script|style|iframe|object|embed|applet)\b[\s\S]*?<\/\1\s*>/gi;
const DANGEROUS_TAG_SELF_CLOSING_RE = /<(script|style|iframe|object|embed|applet)\b[^>]*\/?>/gi;
const EVENT_ATTR_RE = /\s+on\w+\s*=\s*["'][^"']*["']/gi;

function checkHtmlSafety(html: string): { safe: boolean; reason?: string; warnings: string[] } {
  const warnings: string[] = [];

  const hasDangerous =
    DANGEROUS_TAG_RE.test(html) || DANGEROUS_TAG_SELF_CLOSING_RE.test(html);

  if (hasDangerous) {
    // 危险标签严禁
    return {
      safe: false,
      reason: 'HTML 包含禁止的标签（script/style/iframe/object/embed/applet）',
      warnings,
    };
  }

  const hasEvent = EVENT_ATTR_RE.test(html);
  if (hasEvent) {
    warnings.push('已移除事件处理器属性');
  }

  return { safe: true, warnings };
}

function sanitizeHtml(html: string): string {
  // 1. 移除危险标签
  let cleaned = html.replace(DANGEROUS_TAG_RE, '');
  cleaned = cleaned.replace(DANGEROUS_TAG_SELF_CLOSING_RE, '');

  // 2. 移除事件属性（onclick, onerror 等）
  cleaned = cleaned.replace(EVENT_ATTR_RE, '');

  // 3. 移除 javascript: 伪协议 URL
  cleaned = cleaned.replace(/\b(href|src|action)\s*=\s*["'][\s]*javascript\s*:/gi, '$1="#"');

  return cleaned;
}
