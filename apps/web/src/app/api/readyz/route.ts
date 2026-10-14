// BFF handler: GET /api/readyz — Web BFF readiness 探针（DB 感知）。
//
// 与 /api/healthz（纯 liveness）不同：这里通过 prisma 执行 `SELECT 1`，
// 数据库不可达或超过 2 秒即返回 503。响应不含任何内部细节。无需鉴权。

import { NextResponse } from 'next/server';
import { prisma } from '../../../lib/db';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const READY_TIMEOUT_MS = 2000;

export const GET = async () => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      prisma.$queryRaw`SELECT 1`,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('timeout')), READY_TIMEOUT_MS);
      }),
    ]);
    return NextResponse.json({ ok: true }, { headers: { 'Cache-Control': 'no-store' } });
  } catch {
    return NextResponse.json({ ok: false }, { status: 503, headers: { 'Cache-Control': 'no-store' } });
  } finally {
    if (timer) clearTimeout(timer);
  }
};
