// BFF handler: GET /api/healthz — Web BFF liveness 探针。
//
// 用途：
//   - Docker HEALTHCHECK / Kubernetes livenessProbe 调此端点
//   - nginx 反代把 /healthz 转发到 web（无需后端 ai-engine）
//   - 不暴露业务数据；只返 200 + 简短标识
//
// 不走 requireUser；纯 GET；不需要数据库查询；不写入结构化日志避免噪音。

import { NextResponse } from 'next/server';

export const GET = async () => {
  return NextResponse.json({
    ok: true,
    service: 'web',
    timestamp: new Date().toISOString(),
  });
};

// 显式禁止动态缓存，确保每次都走实际进程
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';