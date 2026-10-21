'use client';

import { useEffect, useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import Alert from '@mui/material/Alert';
import CircularProgress from '@mui/material/CircularProgress';
import Link from 'next/link';
import { Pin, PinOff } from 'lucide-react';

import { AppButton as Button } from '@/components/material/AppButton';

export function TopicFollowButton({
  slug,
  initialFollowed,
  isAuthenticated = true,
  onFollowChange,
}: {
  slug: string;
  initialFollowed: boolean;
  isAuthenticated?: boolean;
  onFollowChange?: (followed: boolean) => void;
}) {
  const [followed, setFollowed] = useState(initialFollowed);
  const [actionError, setActionError] = useState<string | null>(null);
  const toggle = useMutation({
    mutationFn: async (next: boolean) => {
      const response = await fetch(`/api/topics/${encodeURIComponent(slug)}/follow`, {
        method: next ? 'POST' : 'DELETE',
      });
      if (!response.ok) {
        const body = await response.json().catch(() => ({})) as { message?: string };
        throw new Error(body.message ?? '更新关注状态失败，请稍后再试。');
      }
      return next;
    },
    onSuccess: (next) => {
      setActionError(null);
      setFollowed(next);
      onFollowChange?.(next);
    },
    onError: (cause) => {
      setActionError(cause instanceof Error ? cause.message : '更新关注状态失败，请稍后再试。');
    },
  });

  useEffect(() => {
    setFollowed(initialFollowed);
  }, [initialFollowed]);

  if (!isAuthenticated) {
    return (
      <Button
        component={Link}
        type="button"
        size="small"
        variant="outlined"
        href={`/signin?callbackUrl=${encodeURIComponent(`/topics/${slug}`)}`}
        startIcon={<Pin aria-hidden />}
      >
        登录后关注
      </Button>
    );
  }

  return (
    <>
      <Button
        type="button"
        size="small"
        variant={followed ? 'outlined' : 'contained'}
        disabled={toggle.isPending}
        aria-busy={toggle.isPending}
        aria-pressed={followed}
        startIcon={toggle.isPending
          ? <CircularProgress size={16} color="inherit" aria-hidden />
          : followed ? <PinOff aria-hidden /> : <Pin aria-hidden />}
        onClick={() => {
          setActionError(null);
          toggle.mutate(!followed);
        }}
      >
        {followed ? '取消关注' : '关注'}
      </Button>
      {actionError ? <Alert severity="error" role="alert">{actionError}</Alert> : null}
    </>
  );
}
