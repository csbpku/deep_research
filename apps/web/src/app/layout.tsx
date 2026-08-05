import type { ReactNode } from 'react';

import { Providers } from './providers';
import { AppShell } from '@/components/shell/AppShell';
import './globals.css';

export const metadata = {
  title: 'AI技术调研平台',
  description: '从技术信号到可复用结论的共享研究空间',
};

/**
 * 首屏防闪脚本：在任何 CSS 生效前把 .dark 打到 <html> 上。
 * 只靠 next-themes 的话主题会在 hydration 时才应用，深色用户会看到一帧白屏。
 * storageKey 必须与 providers.tsx 里 ThemeProvider 的保持一致（dr-theme）。
 */
const themeScript = `
(function () {
  try {
    var stored = localStorage.getItem('dr-theme');
    var theme = stored && stored !== 'system'
      ? stored
      : (window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
    if (theme === 'dark') document.documentElement.classList.add('dark');
  } catch (e) {}
})();
`;

/**
 * 根 layout。AppShell（RSC）提供侧栏 + 顶栏；页面自己决定内容区宽度
 * （列表/控制台 max-w-shell，详情/长文 max-w-measure）。
 */
export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="zh-CN" suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: themeScript }} />
      </head>
      <body className="font-sans">
        <Providers>
          <AppShell>{children}</AppShell>
        </Providers>
      </body>
    </html>
  );
}
