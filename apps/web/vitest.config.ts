import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

const sharedSrc = fileURLToPath(new URL('../../packages/shared/src/index.ts', import.meta.url));
const sharedErrors = fileURLToPath(new URL('../../packages/shared/src/errors.ts', import.meta.url));
const sharedStates = fileURLToPath(new URL('../../packages/shared/src/states.ts', import.meta.url));
const sharedSchemas = fileURLToPath(new URL('../../packages/shared/src/schemas.ts', import.meta.url));
const sharedMetrics = fileURLToPath(new URL('../../packages/shared/src/metrics.ts', import.meta.url));

export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
    globals: false,
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      exclude: ['src/**/*.test.ts', 'src/types/**'],
    },
    // 让 vitest 不通过 ssr-loader 包装这些依赖（next-auth/next/server 不是 Node 入口）
    deps: {
      optimizer: {
        ssr: { external: ['next-auth', 'next/server', 'next'] },
        web: { external: ['next-auth', 'next/server', 'next'] },
      },
    },
  },
  resolve: {
    alias: [
      { find: '@', replacement: fileURLToPath(new URL('./src', import.meta.url)) },
      // 顺序敏感：长路径先匹配
      { find: '@deep-research/shared/errors', replacement: sharedErrors },
      { find: '@deep-research/shared/states', replacement: sharedStates },
      { find: '@deep-research/shared/schemas', replacement: sharedSchemas },
      { find: '@deep-research/shared/metrics', replacement: sharedMetrics },
      { find: '@deep-research/shared', replacement: sharedSrc },
    ],
  },
});