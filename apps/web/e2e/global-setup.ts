// Playwright global setup —— 预热所有 E2E 用到的路由。
//
// 背景：
//   - next dev 默认懒编译：第一次请求某个 route 时才编译
//   - CI 用 2 worker 并行跑测试；同时请求未编译的 route 可能导致
//     dev server 短暂 500 或响应丢失（cross-flows.spec.ts 出现过
//     `/api/summaries` 500 但 server log 无对应 GET 的情况）
//   - pre-warm 后所有 route 已编译好，所有测试拿到真实响应
//
// 注意：
//   - 只 ping，不需要校验响应（401 / 200 都行，只要触发编译）
//   - 用独立的 fetch，不依赖 Playwright 的 fixture

const BASE_URL = process.env.E2E_BASE_URL ?? 'http://localhost:3000';

const WARMUP_ENDPOINTS = [
  // 公共
  '/api/summaries',
  '/api/summaries/00000000-0000-4000-8000-000000000000',
  '/api/search?q=test',
  '/api/radar',
  '/api/radar-feedback',
  '/api/radar/00000000-0000-4000-8000-000000000000',
  '/api/researches',
  // 鉴权（期望 401，足以触发编译）
  '/api/admin/dashboard',
  '/api/admin/comments',
  '/api/admin/shares',
  '/api/admin/ping',
  '/api/admin/radar',
  // UI 页面（用于 redirect 测试）
  '/admin',
  '/signin',
  '/summaries',
  '/',
];

export default async function globalSetup() {
  for (const path of WARMUP_ENDPOINTS) {
    try {
      await fetch(`${BASE_URL}${path}`, { method: 'GET' });
    } catch {
      // 忽略错误：目的是触发编译，不是校验
    }
  }
}