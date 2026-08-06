'use client';

// 首页 / 父页通用的"刚提交的调研"提醒横幅。
// 数据来源:sessionStorage('ai-research:last-submitted:v1'),120s TTL。

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { Rocket, X } from 'lucide-react';

import { Button } from '@/components/ui/button';
import {
  type LastSubmitted,
  clearLastSubmitted,
  readLastSubmitted,
} from '@/lib/last-submitted';

export function LastSubmittedBanner() {
  const [entry, setEntry] = useState<LastSubmitted | null>(null);

  useEffect(() => {
    setEntry(readLastSubmitted());
  }, []);

  if (!entry) return null;

  return (
    <div
      role="status"
      className="flex flex-wrap items-center gap-3 rounded-md border border-border bg-card px-3 py-2 text-sm"
    >
      <Rocket className="size-4 shrink-0 text-muted-foreground" />
      <span className="flex-1 text-muted-foreground">
        刚提交的:<strong className="font-medium text-foreground">{entry.topic}</strong>
      </span>
      <Button asChild size="xs" variant="outline">
        <Link href={`/ai-research/${entry.jobId}`}>查看进度</Link>
      </Button>
      <Button
        type="button"
        variant="ghost"
        size="icon-sm"
        onClick={() => {
          clearLastSubmitted();
          setEntry(null);
        }}
        aria-label="关闭"
      >
        <X />
      </Button>
    </div>
  );
}
