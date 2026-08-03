import type { NextConfig } from 'next';
import path from 'node:path';

// AI engine 反代仅由 infra/nginx.conf 的 /ai/ location 负责。
// web 这一层不代理 ai-engine：dev 模式下用 .env 的 AI_ENGINE_URL
// 直接调（前端通过 BFF API /api/ai/*，不在这里 rewrites）。
// 详见 docs/decisions/2026-07-17-no-double-proxy.md。
const config: NextConfig = {
  reactStrictMode: true,
  outputFileTracingRoot: path.join(__dirname, '../..'),
  experimental: {
    // Server Actions 默认开启
    serverActions: {
      bodySizeLimit: '5mb', // P0 文件导入限制
    },
  },
};

export default config;
