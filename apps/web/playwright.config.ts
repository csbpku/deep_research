// Playwright E2E 配置 —— Week 9+ 补测。
//
// 覆盖：
//   - 公共：登录跳转、Admin 权限拦截
//   - 雷达/摘要/沉淀/AI 调研/Admin 各模块关键流程
//   - 跨模块关键路径
//
// 状态：
//   - 本地可跑：pnpm test:e2e（需要先 build + 起 web + 真实 DB + 真实 AI engine）
//   - CI 集成：Week 11 之后接入（暂未实现；详见 docs/E2E_TESTING.md）

import { defineConfig, devices } from '@playwright/test';

const BASE_URL = process.env.E2E_BASE_URL ?? 'http://localhost:3000';

export default defineConfig({
  testDir: './e2e',
  // 匹配 testDir 下的 .spec.ts 文件（避免扫到 src/** 的 vitest .test.ts）
  testMatch: '**/*.spec.ts',
  // 预热所有 E2E 用到的 route：next dev 懒编译 + 多 worker 并行
  // 首次请求未编译 route 时偶发 500。globalSetup 触发一次编译，
  // 让所有 spec 拿到的是已就绪的 endpoint。
  globalSetup: './e2e/global-setup.ts',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: process.env.CI ? 2 : undefined,
  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : 'list',

  // 串行启动 web（ai-engine 由 dev:ai 单独起；详见 docs/E2E_TESTING.md）
  webServer: {
    command: 'pnpm dev',
    url: BASE_URL,
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
    stdout: 'pipe',
    stderr: 'pipe',
    env: {
      E2E: '1',
      // Auth.js builds callback redirects from NEXTAUTH_URL. Keep it aligned
      // with Playwright's target so custom/CI ports never redirect into a
      // different local service.
      NEXTAUTH_URL: BASE_URL,
    },
  },

  use: {
    baseURL: BASE_URL,
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
  },

  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
});
