'use client';

import Link from 'next/link';
import { ArrowLeft } from 'lucide-react';
import { useSearchParams } from 'next/navigation';

import { Button } from '@/components/ui/button';

export function BackToSearchButton() {
  const searchParams = useSearchParams();
  const returnTo = searchParams.get('returnTo');

  if (!returnTo || !returnTo.startsWith('/search')) return null;

  return (
    <Button asChild variant="outline" size="sm">
      <Link href={returnTo}>
        <ArrowLeft />
        返回搜索结果
      </Link>
    </Button>
  );
}
