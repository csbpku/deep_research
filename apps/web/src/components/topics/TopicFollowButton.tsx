'use client';

import { useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import { Pin, PinOff, Loader2 } from 'lucide-react';
import Link from 'next/link';

import { Button } from '@/components/ui/button';

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
  const toggle = useMutation({
    mutationFn: async (next: boolean) => {
      const r = await fetch(`/api/topics/${slug}/follow`, { method: next ? 'POST' : 'DELETE' });
      if (!r.ok) {
        const data = await r.json().catch(() => ({}));
        throw new Error((data as { message?: string }).message ?? '操作失败');
      }
      return r.json();
    },
    onSuccess: (_, next) => {
      setFollowed(next);
      onFollowChange?.(next);
    },
  });

  if (!isAuthenticated) {
    return (
      <Button asChild type="button" size="sm" variant="outline" className="min-h-11 sm:min-h-9">
        <Link href={`/signin?callbackUrl=${encodeURIComponent(`/topics/${slug}`)}`}>
          <Pin className="size-4" />
          登录后关注
        </Link>
      </Button>
    );
  }

  return (
    <Button
      type="button"
      size="sm"
      variant={followed ? 'outline' : 'default'}
      className="min-h-11 sm:min-h-9"
      disabled={toggle.isPending}
      onClick={() => toggle.mutate(!followed)}
    >
      {toggle.isPending ? <Loader2 className="size-4 animate-spin" /> : followed ? <PinOff className="size-4" /> : <Pin className="size-4" />}
      {followed ? '取消关注' : '关注'}
    </Button>
  );
}
