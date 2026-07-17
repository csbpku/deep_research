import type { NextConfig } from 'next';

const config: NextConfig = {
  reactStrictMode: true,
  experimental: {
    // Server Actions 默认开启
    serverActions: {
      bodySizeLimit: '5mb', // P0 文件导入限制
    },
  },
  // apps/web 只反代 AI engine；infra 反代 nginx 负责 web → ai-engine 路由
  async rewrites() {
    return [
      {
        source: '/ai/:path*',
        destination: `${process.env.AI_ENGINE_URL ?? 'http://localhost:4000'}/:path*`,
      },
    ];
  },
};

export default config;
