'use client';

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ThemeProvider } from 'next-themes';
import { useState, type ReactNode } from 'react';

import { MaterialProvider } from '@/components/material/MaterialProvider';

/**
 * 客户端 providers。
 * - TanStack Query：全站数据层
 * - next-themes：浅/深色主题（attribute="class"，驱动共享深浅色 tokens）
 *   首屏防闪由 layout.tsx <head> 里的内联阻塞脚本负责，这里只管切换与持久化。
 */
export function Providers({ children }: { children: ReactNode }) {
  const [client] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: {
            staleTime: 30_000,
            refetchOnWindowFocus: false,
            retry: 1,
          },
        },
      }),
  );

  return (
    <QueryClientProvider client={client}>
      <ThemeProvider
        attribute="class"
        defaultTheme="system"
        enableSystem
        disableTransitionOnChange
        storageKey="dr-theme"
      >
        <MaterialProvider>{children}</MaterialProvider>
      </ThemeProvider>
    </QueryClientProvider>
  );
}
