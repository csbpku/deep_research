'use client';

import { ArrowLeft, Home, RotateCw } from 'lucide-react';
import { useRouter } from 'next/navigation';

import { Button } from '@/components/ui/button';

export function RouteErrorState({
  title = '页面暂时无法打开',
  description = '页面加载时遇到了一点问题。可以重试当前页面，或回到工作台继续。',
  reset,
}: {
  title?: string;
  description?: string;
  reset: () => void;
}) {
  const router = useRouter();

  return (
    <main className="mx-auto flex min-h-[60vh] w-full max-w-measure items-center justify-center px-4 py-10">
      <section
        role="alert"
        aria-live="assertive"
        className="w-full rounded-md border border-destructive/35 bg-destructive/5 p-5 sm:p-6"
      >
        <p className="text-sm font-semibold text-destructive">{title}</p>
        <p className="mt-2 text-sm leading-6 text-muted-foreground">{description}</p>
        <div className="mt-5 flex flex-wrap gap-2">
          <Button type="button" onClick={reset}>
            <RotateCw />
            重试
          </Button>
          <Button type="button" variant="outline" onClick={() => router.back()}>
            <ArrowLeft />
            返回上一页
          </Button>
          <Button type="button" variant="ghost" onClick={() => router.push('/')}>
            <Home />
            回到工作台
          </Button>
        </div>
      </section>
    </main>
  );
}
