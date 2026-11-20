// BFF handler: GET /api/ai-research/preflight — 启动前预检代理。
//
// 确认页在启用「开始研究」前调用；AI engine 负责检查模型槽位、凭据、
// 检索配置，并做一次有界的模型连通性探测。BFF 只做鉴权与透传。
// 引擎不可达时返回 200 + 非阻断的 warning：BFF 无法区分“配置错”与
// “引擎刚重启”，此时锁死开始按钮会让用户无从操作；真正的配置错误由
// 引擎返回 ok:false，仍然阻断。

import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';

import { apiHandler } from '@/lib/api-handler';
import { requireUser } from '@/lib/auth/session';
import { fetchAiEngine } from '@/lib/ai-bff/fetch-ai-engine';
import { getWebEnv } from '@/lib/env';
import { withRequestId } from '@/lib/log';

interface PreflightCheck {
  name: string;
  ok: boolean;
  message: string;
  level?: 'warning' | 'error';
}

interface EnginePreflightResponse {
  ok: boolean;
  checks: PreflightCheck[];
  checkedAt: string;
}

function unavailablePreflight(message: string): NextResponse {
  return NextResponse.json({
    ok: true,
    checks: [{ name: 'ai_engine', ok: true, level: 'warning', message }],
    checkedAt: new Date().toISOString(),
  });
}

export const GET = apiHandler<[NextRequest]>(async (req) => {
  const requestId = withRequestId(req.headers);
  const u = await requireUser(req);
  if (u instanceof NextResponse) return u;

  const refresh = new URL(req.url).searchParams.get('refresh') === '1';
  const upstream = `${getWebEnv().AI_ENGINE_URL.replace(/\/$/u, '')}/health/preflight${
    refresh ? '?force=true' : ''
  }`;
  const fetched = await fetchAiEngine<EnginePreflightResponse>({
    url: upstream,
    requestId,
    context: 'ai.bff.preflight',
    // 预检本身已有 4s 探测上限；BFF 再留一点余量，但绝不重试，
    // 避免确认页在引擎异常时等待两轮。
    timeoutMs: 6_000,
    retry: false,
  });

  if (!fetched.ok) {
    return unavailablePreflight(
      fetched.code === 'AI_ENGINE_UNAVAILABLE'
        ? 'AI 调研服务暂时不可用，请确认 AI engine 已启动后重试。'
        : `启动前检查失败：${fetched.message}`,
    );
  }

  const body = fetched.body;
  const checks = Array.isArray(body?.checks)
    ? body.checks
        .filter(
          (check): check is PreflightCheck =>
            typeof check?.name === 'string' &&
            typeof check.ok === 'boolean' &&
            typeof check.message === 'string',
        )
        .map((check) => ({
          name: check.name,
          ok: check.ok,
          message: check.message,
          ...(check.level === 'warning' || check.level === 'error'
            ? { level: check.level }
            : {}),
        }))
    : [];
  const checkedAt =
    typeof body?.checkedAt === 'string' ? body.checkedAt : new Date().toISOString();

  return NextResponse.json({
    ok: body?.ok === true && checks.length > 0 && checks.every((check) => check.ok),
    checks,
    checkedAt,
  });
});

export const dynamic = 'force-dynamic';
