'use client';

// useMediaQuery —— 订阅 CSS 媒体查询，返回 boolean。
//
// SSR 期间返回 false（默认桌面）；mount 后用 matchMedia 重新校准。
// 这样服务端首屏渲染保持稳定，客户端 hydrate 后立刻对齐真实环境。
//
// 用法：
//   const isDesktop = useMediaQuery('(min-width: 768px)');

import { useEffect, useState } from 'react';

export function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState(false);

  useEffect(() => {
    if (typeof window === 'undefined' || !window.matchMedia) return;
    const mql = window.matchMedia(query);
    setMatches(mql.matches);
    function onChange(e: MediaQueryListEvent) {
      setMatches(e.matches);
    }
    // Safari < 14 用 addListener
    if (mql.addEventListener) {
      mql.addEventListener('change', onChange);
      return () => mql.removeEventListener('change', onChange);
    }
    mql.addListener(onChange);
    return () => mql.removeListener(onChange);
  }, [query]);

  return matches;
}
