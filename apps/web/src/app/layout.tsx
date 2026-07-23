import type { ReactNode } from 'react';
import { Providers } from './providers';
import { Nav } from '../components/Nav';
import './globals.css';

export const metadata = {
  title: '技术调研平台',
  description: '个人深度研究 / 技术调研平台',
};

/**
 * 根 layout。所有页面都套 TanStack Query provider + 顶部导航。
 *
 * 注意：Nav 是 Client Component（需要 useSession），会读 cookie 显示登录态。
 */
export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="zh-CN">
      <body>
        <Providers>
          <Nav />
          <main style={{ maxWidth: 960, margin: '0 auto', padding: '24px 16px' }}>{children}</main>
        </Providers>
      </body>
    </html>
  );
}