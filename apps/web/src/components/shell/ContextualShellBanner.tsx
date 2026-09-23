'use client';

import type { ReactNode } from 'react';
import { usePathname } from 'next/navigation';

/**
 * Keep cross-product notifications out of focused reading surfaces.
 * The unread-topic banner remains available on radar list/topic workspaces.
 */
export function ContextualShellBanner({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const isRadarDetail = Boolean(pathname?.match(/^\/radar\/[^/]+(?:\/|$)/u));

  if (isRadarDetail) return null;
  return children;
}
