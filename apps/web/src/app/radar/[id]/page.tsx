'use client';

import Link from 'next/link';
import { useParams, useSearchParams } from 'next/navigation';
import { useEffect } from 'react';
import { Loader2, RotateCw } from 'lucide-react';
import { useQuery } from '@tanstack/react-query';

import { EmptyState } from '../../../components/EmptyState';
import { RadarExternalReadingLanding } from '../../../components/radar/RadarExternalReadingLanding';
import { BackToSearchButton } from '../../../components/domain/BackToSearchButton';
import { Button } from '../../../components/ui/button';
import type { RadarFeedbackCounts } from '../../../components/radar/RadarFeedbackBar';
import type { RadarFeedbackType } from '@deep-research/shared/states';
import type { DistilledScore } from '@deep-research/shared/schemas';
import { retryOnceAi } from '../../../lib/errors/friendly';
import { toApiHttpError } from '../../../lib/errors/api-error';

interface RadarDetail {
  id: string;
  title: string;
  excerpt: string;
  body: string | null;
  tier: string | null;
  url: string;
  sourceType: string | null;
  sourceName: string | null;
  originalKind: string | null;
  tags: string[];
  status: string;
  publishedAt: string | null;
  crawledAt: string;
  interpretation: string | null;
  scoreReason: string | null;
  distilledScore: DistilledScore | null;
  selectionReason: string | null;
  feedbackCounts: RadarFeedbackCounts;
  myFeedbacks: RadarFeedbackType[];
  isAuthenticated: boolean;
  canManage: boolean;
}

const REQUEST_TIMEOUT_MS = 20_000;

async function fetchRadarDetail(path: string, signal: AbortSignal): Promise<RadarDetail> {
  const controller = new AbortController();
  const timeoutId = window.setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  const abortFromQuery = () => controller.abort();

  if (signal.aborted) {
    controller.abort();
  } else {
    signal.addEventListener('abort', abortFromQuery, { once: true });
  }

  try {
    const response = await fetch(path, { cache: 'no-store', signal: controller.signal });
    if (!response.ok) {
      throw await toApiHttpError(response, '读取雷达详情超时，请重试。'.replace('超时，请重试。', ''));
    }
    return (await response.json()) as RadarDetail;
  } catch (error) {
    if (controller.signal.aborted && !signal.aborted) {
      throw new Error('读取雷达详情超时，请重试。');
    }
    throw error;
  } finally {
    window.clearTimeout(timeoutId);
    signal.removeEventListener('abort', abortFromQuery);
  }
}

export default function RadarDetailPage() {
  const params = useParams<{ id: string }>();
  const searchParams = useSearchParams();
  const returnQuery = searchParams.get('from');
  const backHref = returnQuery ? `/radar?${returnQuery}` : '/radar';

  const query = useQuery<RadarDetail>({
    queryKey: ['radar', params.id],
    queryFn: ({ signal }) => fetchRadarDetail(`/api/radar/${params.id}?surface=summary`, signal),
    retry: retryOnceAi,
    staleTime: 30_000,
  });

  useEffect(() => {
    document.querySelector<HTMLElement>('main')?.scrollTo({ top: 0, left: 0, behavior: 'auto' });
    window.scrollTo({ top: 0, left: 0, behavior: 'auto' });
  }, [params.id]);

  if (query.isLoading) {
    return (
      <div className="flex min-h-0 flex-1 flex-col overflow-y-auto bg-[var(--ink-page)]" role="status" aria-live="polite">
        <div className="flex items-center justify-between border-b border-[var(--ink-rule)] px-4 py-3 sm:px-6">
          <div className="flex items-center gap-2">
            <BackToSearchButton />
            <Link href={backHref} className="text-sm text-[var(--ink-muted)] hover:text-[var(--ink-accent)]">回到雷达</Link>
          </div>
          <div className="h-9 w-24 animate-pulse bg-[var(--ink-surface)]" />
        </div>
        <div className="mx-auto w-full max-w-7xl px-5 py-10 sm:px-8 lg:py-14">
          <Loader2 className="size-5 animate-spin text-[var(--ink-accent)]" aria-hidden />
          <p className="mt-4 text-sm font-medium text-[var(--ink-text)]">正在准备雷达简报</p>
          <div className="mt-7 max-w-4xl space-y-3">
            <div className="h-3 w-32 animate-pulse bg-[var(--ink-surface)]" />
            <div className="h-12 w-full animate-pulse bg-[var(--ink-surface)]" />
            <div className="h-24 w-full animate-pulse bg-[var(--ink-surface)]" />
          </div>
        </div>
      </div>
    );
  }

  if (query.isError) {
    const errorMessage = String((query.error as Error).message);
    const needsLogin = errorMessage.includes('登录') || errorMessage.includes('授权');
    return (
      <div className="mx-auto w-full max-w-3xl px-5 py-8 sm:px-8">
        <div className="flex items-center gap-2">
          <BackToSearchButton />
          <Link href={backHref} className="text-sm text-muted-foreground hover:text-primary">返回雷达</Link>
        </div>
        <div className="mt-6">
          <EmptyState
            title={needsLogin ? '需要登录' : '加载失败'}
            description={needsLogin ? '登录后才能查看雷达详情、评分和讨论。' : errorMessage}
            action={needsLogin ? (
              <Button asChild size="sm">
                <Link href="/signin">去登录</Link>
              </Button>
            ) : (
              <Button type="button" size="sm" variant="outline" onClick={() => void query.refetch()}>
                <RotateCw className="size-3.5" />
                重新加载
              </Button>
            )}
          />
        </div>
      </div>
    );
  }

  if (!query.data) return null;

  return <RadarExternalReadingLanding detail={query.data} backHref={backHref} />;
}
