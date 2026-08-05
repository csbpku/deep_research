// BFF handler: POST /api/radar/submissions/upload — 文件类雷达候选 (P1-B)。
//
// 流程：
//   1. requireUser
//   2. multipart 解析（Next 15 App Router 原生 FormData）
//   3. magic bytes / 扩展名 / MIME / 大小 校验
//   4. SHA-256 计算 → dedup 检查
//   5. 落盘到 apps/web/data/import-tmp/<sha256>.<ext>（已存在的清理脚本会兜底）
//   6. INSERT radar_submissions (status=type_detected)
//   7. enqueue worker
import { NextResponse } from 'next/server';
import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import type { NextRequest } from 'next/server';

import { apiHandler } from '@/lib/api-handler';
import { prisma } from '@/lib/db';
import { requireUser } from '@/lib/auth/session';
import { toApiErrorResponse } from '@/lib/errors';
import { withRequestId } from '@/lib/log';
import {
  detectFileKind,
  MAX_FILE_BYTES,
  sha256,
  type FileKind,
} from '@/lib/radar/submissions/detect';
import { enqueueRadarSubmission } from '@/lib/radar/submissions/worker-bridge';
import { ERROR_CODES } from '@deep-research/shared/errors';

const UPLOAD_DIR = resolve(
  process.env.IMPORT_TEMP_DIR ?? join(process.cwd(), 'data', 'import-tmp'),
);

const EXT_BY_KIND: Record<FileKind, string> = {
  pdf: 'pdf',
  markdown: 'md',
  html: 'html',
  txt: 'txt',
};

export const POST = apiHandler<[NextRequest]>(async (req) => {
  const user = await requireUser(req);
  if (user instanceof NextResponse) return user;
  const requestId = withRequestId(req.headers);

  let form: FormData;
  try {
    form = await req.formData();
  } catch (err) {
    return toApiErrorResponse({
      code: ERROR_CODES.VALIDATION_FAILED,
      message: '请求体必须为 multipart/form-data',
      requestId,
    });
  }

  const file = form.get('file');
  if (!(file instanceof File)) {
    return toApiErrorResponse({
      code: ERROR_CODES.VALIDATION_FAILED,
      message: '缺少 file 字段',
      requestId,
    });
  }
  if (file.size > MAX_FILE_BYTES) {
    return toApiErrorResponse({
      code: ERROR_CODES.VALIDATION_FAILED,
      message: `文件超过 ${Math.floor(MAX_FILE_BYTES / 1024 / 1024)} MB 上限`,
      requestId,
    });
  }
  if (file.size === 0) {
    return toApiErrorResponse({
      code: ERROR_CODES.VALIDATION_FAILED,
      message: '空文件',
      requestId,
    });
  }

  const buf = Buffer.from(await file.arrayBuffer());
  const head = buf.subarray(0, Math.min(buf.length, 256));
  const detected = detectFileKind({ filename: file.name, mimeType: file.type, head });
  if (!detected) {
    return toApiErrorResponse({
      code: ERROR_CODES.VALIDATION_FAILED,
      message: '文件类型不支持（仅 PDF / Markdown / HTML / TXT）',
      requestId,
    });
  }

  const contentSha256 = sha256(buf);

  // 文件去重：同 (submitter, sha256) 在非终态已存在 → 409
  const existing = await prisma.radarSubmission.findFirst({
    where: {
      submitterId: user.id,
      contentSha256,
      status: { notIn: ['completed', 'duplicate', 'failed'] },
    },
    select: { id: true, status: true },
  });
  if (existing) {
    return NextResponse.json(
      { code: 'RADAR_SUBMISSION_DUPLICATE_ACTIVE', submissionId: existing.id, status: existing.status, requestId },
      { status: 409 },
    );
  }

  // 落盘到 import-tmp/<sha>.<ext>；worker 抽取完成后清理由 cron 处理
  const filename = `${contentSha256}.${EXT_BY_KIND[detected]}`;
  const storedPath = join(UPLOAD_DIR, filename);
  try {
    await mkdir(UPLOAD_DIR, { recursive: true });
    await writeFile(storedPath, buf, { flag: 'wx' }); // 拒绝覆盖
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'EEXIST') {
      // 内容相同的另一份已落盘，正常继续
    } else {
      throw err;
    }
  }

  const created = await prisma.radarSubmission.create({
    data: {
      submitterId: user.id,
      kind: detected,
      rawInput: file.name,
      canonicalUrl: null,
      contentSha256,
      detectedKind: detected,
      status: 'type_detected',
    },
    select: { id: true, status: true, detectedKind: true, createdAt: true },
  });

  enqueueRadarSubmission(created.id).catch((err) => {
    console.error('[radar-submission] enqueue failed', { id: created.id, err });
  });

  return NextResponse.json(
    {
      ok: true,
      submission: {
        id: created.id,
        status: created.status,
        detectedKind: created.detectedKind,
        contentSha256,
        sizeBytes: buf.length,
        createdAt: created.createdAt.toISOString(),
      },
      requestId,
    },
    { status: 202 },
  );
});
