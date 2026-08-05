'use client';

import { useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import { Pin, PinOff, Loader2 } from 'lucide-react';

import { Button } from '@/components/ui/button';

export function TopicFollowButton({ slug, initialFollowed }: { slug: string; initialFollowed: boolean }) {
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
    onSuccess: (_, next) => setFollowed(next),
  });
  return (
    <Button
      type="button"
      size="sm"
      variant={followed ? 'outline' : 'default'}
      disabled={toggle.isPending}
      onClick={() => toggle.mutate(!followed)}
    >
      {toggle.isPending ? <Loader2 className="size-4 animate-spin" /> : followed ? <PinOff className="size-4" /> : <Pin className="size-4" />}
      {followed ? '取消关注' : '关注'}
    </Button>
  );
}
