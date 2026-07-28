// Playwright fixtures —— 通用 helpers。
//
// 范围（Week 9 起步）：
//   - mockNextAuthSession：通过注入 NextAuth session cookie 模拟登录
//   - 公共清理：测试间不共享状态；每个 spec 自带 beforeAll/afterAll
//
// 注意：fixture 暂时只 mock session；不要直接调 prisma 客户端（要保持
// E2E 关注真实链路）。需要 seed 数据时通过测试专用的 API 路由做。

import type { APIRequestContext, Page } from '@playwright/test';

export const SESSION_COOKIE_NAME = 'authjs.session-token';

/** 通过设置 NextAuth session cookie 模拟登录。 */
export async function mockLogin(
  request: APIRequestContext,
  context: { addCookies: (cookies: { name: string; value: string; domain: string; path: string }[]) => Promise<void> },
  user: { id: string; email: string; name: string; role: 'member' | 'admin' },
): Promise<void> {
  // 真实 E2E 应该通过 NextAuth OAuth 回调完成登录，但起步阶段可以
  // 通过测试用的 dev-only 路由直接设 cookie（参见 e2e/api-helper.spec.ts）。
  // 这里预留：调用 dev-only 路由 /api/test/login 拿 session cookie。
  const res = await request.post(`${process.env.E2E_BASE_URL ?? 'http://localhost:3000'}/api/test/login`, {
    data: user,
    headers: { 'content-type': 'application/json' },
  });
  if (!res.ok()) {
    throw new Error(`mockLogin failed: ${res.status()} ${await res.text()}`);
  }
  const setCookie = res.headers()['set-cookie'];
  if (!setCookie) {
    throw new Error('mockLogin: no Set-Cookie header returned');
  }
  // Set-Cookie 是字符串，提取 name=value
  const cookieValue = setCookie.split(';')[0];
  const [name, value] = cookieValue.split('=');
  await context.addCookies([
    { name: name.trim(), value: value.trim(), domain: 'localhost', path: '/' },
  ]);
}

/** 清空页面（不依赖真实网络） */
export async function waitForHydration(page: Page): Promise<void> {
  await page.waitForLoadState('networkidle');
}