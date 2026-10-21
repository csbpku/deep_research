'use client';

import Link from 'next/link';
import { ArrowLeft } from 'lucide-react';
import { useSearchParams } from 'next/navigation';

import { AppButton } from '@/components/material/AppButton';

export function BackToSearchButton() {
  const searchParams = useSearchParams();
  const returnTo = searchParams.get('returnTo');

  if (!returnTo || !returnTo.startsWith('/search')) return null;

  return (
    <AppButton
      component={Link}
      href={returnTo}
      variant="outlined"
      size="small"
      startIcon={<ArrowLeft aria-hidden="true" />}
    >
      返回搜索结果
    </AppButton>
  );
}
