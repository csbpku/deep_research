import type { ReactNode } from 'react';
import { IBM_Plex_Sans, JetBrains_Mono } from 'next/font/google';

import { Providers } from './providers';
import { AppShell } from '@/components/shell/AppShell';
import './globals.css';

/**
 * 字体："Developer Mono" 配对 —— IBM Plex Sans（UI/正文）+ JetBrains Mono（ID/指标/代码）。
 *
 * ⚠️ Plex 没有中文字形，中文必须走 tailwind.config.ts fontFamily 里的系统回退链
 * （PingFang SC / Noto Sans SC / Microsoft YaHei）。
 * ⚠️ next/font/google 在 `next build` 时联网下载并自托管。若内网构建环境无外网，
 * 改用 next/font/local + 把 woff2 放进 src/assets/fonts/。
 */
const plexSans = IBM_Plex_Sans({
  subsets: ['latin'],
  weight: ['400', '500', '600', '700'],
  variable: '--font-sans',
  display: 'swap',
});

const jetbrainsMono = JetBrains_Mono({
  subsets: ['latin'],
  weight: ['400', '500', '600'],
  variable: '--font-mono',
  display: 'swap',
});

export const metadata = {
  title: '技术调研平台',
  description: '个人深度研究 / 技术调研平台',
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
    <html
      lang="zh-CN"
      className={`${plexSans.variable} ${jetbrainsMono.variable}`}
      suppressHydrationWarning
    >
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
