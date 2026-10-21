'use client';

import Link from 'next/link';
import { useParams, useSearchParams } from 'next/navigation';
import { useEffect } from 'react';
import { RotateCw } from 'lucide-react';
import Box from '@mui/material/Box';
import CircularProgress from '@mui/material/CircularProgress';
import { useQuery } from '@tanstack/react-query';

import { EmptyState } from '../../../components/EmptyState';
import { RadarExternalReadingLanding } from '../../../components/radar/RadarExternalReadingLanding';
import { BackToSearchButton } from '../../../components/domain/BackToSearchButton';
import { AppButton } from '../../../components/material/AppButton';
import Skeleton from '@mui/material/Skeleton';
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
      <Box sx={{ display: 'flex', minHeight: 0, flex: 1, flexDirection: 'column', overflowY: 'auto', bgcolor: 'background.default' }} role="status" aria-live="polite">
        <Box component="header" sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', minHeight: 56, px: { xs: 2, sm: 3 }, py: 1.5, borderBottom: 1, borderColor: 'divider' }}>
          <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
            <BackToSearchButton />
            <AppButton component={Link} href={backHref} variant="text" color="inherit">回到雷达</AppButton>
          </Box>
          <Skeleton variant="rounded" width={96} height={36} />
        </Box>
        <Box sx={{ mx: 'auto', width: '100%', maxWidth: 1280, px: { xs: 2, sm: 3, md: 4 }, py: { xs: 4, sm: 5 } }}>
          <CircularProgress size={20} aria-label="正在准备雷达简报" />
          <Skeleton variant="text" sx={{ mt: 2, height: 28, width: 176 }} />
          <Box sx={{ display: 'flex', flexDirection: 'column', gap: 1.5, mt: 3, maxWidth: 720 }}>
            <Skeleton variant="text" width={128} />
            <Skeleton variant="text" sx={{ height: 44 }} />
            <Skeleton variant="rounded" sx={{ height: 96 }} />
          </Box>
        </Box>
      </Box>
    );
  }

  if (query.isError) {
    const errorMessage = String((query.error as Error).message);
    const needsLogin = errorMessage.includes('登录') || errorMessage.includes('授权');
    return (
      <Box sx={{ mx: 'auto', width: '100%', maxWidth: 768, px: { xs: 2, sm: 3 }, py: 4 }}>
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
          <BackToSearchButton />
          <AppButton component={Link} href={backHref} variant="text" color="inherit">返回雷达</AppButton>
        </Box>
        <Box sx={{ mt: 3 }}>
          <EmptyState
            title={needsLogin ? '需要登录' : '加载失败'}
            description={needsLogin ? '登录后才能查看雷达详情、评分和讨论。' : errorMessage}
            action={needsLogin ? (
              <AppButton component={Link} href="/signin" variant="contained">去登录</AppButton>
            ) : (
              <AppButton type="button" variant="outlined" onClick={() => void query.refetch()} startIcon={<RotateCw aria-hidden />}>
                重新加载
              </AppButton>
            )}
          />
        </Box>
      </Box>
    );
  }

  if (!query.data) return null;

  return <RadarExternalReadingLanding detail={query.data} backHref={backHref} />;
}
