'use client';

// 待处理入口：把两类“该我处理”的内容放在一个页面，而不是让用户记住
// 研究库里两个互不相干的筛选器。这里只做聚合与跳转，具体动作仍在详情页
// （判断顺延/修订/归档、学习自检）完成，避免出现第二套业务规则。
import React from 'react';
import Link from 'next/link';
import { useQuery } from '@tanstack/react-query';
import { AlarmClock, BookOpenCheck, ChevronRight } from 'lucide-react';
import Paper from '@mui/material/Paper';
import Skeleton from '@mui/material/Skeleton';
import Alert from '@mui/material/Alert';

import { PageHeader } from '@/components/domain/PageHeader';
import { AppButton } from '@/components/material/AppButton';

interface QueueItem {
  id: string;
  title: string;
  judgementDue?: { due: boolean; daysOverdue: number };
  reviewDue?: { missed: number; unsure: number };
}

interface QueueResponse {
  items: QueueItem[];
  total: number;
}

function useQueue(query: string) {
  return useQuery<QueueResponse>({
    queryKey: ['review-queue', query],
    queryFn: async () => {
      const res = await fetch(`/api/researches?${query}&limit=5`);
      if (!res.ok) throw new Error('待处理内容暂时无法读取。');
      return res.json();
    },
  });
}

function QueueSection({ title, description, href, query, icon, render }: {
  title: string;
  description: string;
  href: string;
  query: string;
  icon: React.ReactNode;
  render: (item: QueueItem) => React.ReactNode;
}) {
  const { data, isLoading, isError } = useQueue(query);
  return (
    <Paper variant="outlined" sx={{ p: 3 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
        {icon}
        <h2 style={{ margin: 0, fontSize: 18 }}>{title}</h2>
      </div>
      <p style={{ margin: '0 0 16px', color: 'var(--dr-color-text-secondary)', fontSize: 14 }}>{description}</p>
      {isLoading ? <Skeleton variant="rounded" height={72} /> : null}
      {isError ? <Alert severity="error">读取失败，请稍后重试。</Alert> : null}
      {!isLoading && !isError && (data?.items.length ?? 0) === 0 ? (
        <p style={{ margin: 0, color: 'var(--dr-color-text-secondary)', fontSize: 14 }}>暂时没有需要处理的内容。</p>
      ) : null}
      <div style={{ display: 'grid', gap: 8 }}>
        {data?.items.map(item => (
          <div key={item.id} style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '10px 0', borderTop: '1px solid var(--dr-color-outline)' }}>
            <div style={{ flex: 1, minWidth: 0 }}>
              <Link href={`/researches/${item.id}`} style={{ fontWeight: 600 }}>{item.title}</Link>
              <div style={{ marginTop: 4, display: 'flex', gap: 8, alignItems: 'center' }}>{render(item)}</div>
            </div>
            <AppButton component={Link} href={`/researches/${item.id}`} size="small" variant="text" endIcon={<ChevronRight size={14} />}>
              处理
            </AppButton>
          </div>
        ))}
      </div>
      {(data?.total ?? 0) > 5 ? (
        <div style={{ marginTop: 12 }}>
          <AppButton component={Link} href={href} variant="outlined" size="small">查看全部 {data?.total} 条</AppButton>
        </div>
      ) : null}
    </Paper>
  );
}

export default function ReviewQueuePage() {
  return (
    <div className="material-surface" style={{ padding: 'var(--dr-space-lg)' }}>
      <PageHeader
        title="待处理"
        description="判断会过期，学习会遗忘。这里集中列出需要你重新确认的内容。"
      />
      <div style={{ display: 'grid', gap: 16, gridTemplateColumns: 'repeat(auto-fit, minmax(320px, 1fr))' }}>
        <QueueSection
          title="判断待复查"
          description="已发布的知识卡，判断的复查时间已到。确认仍成立、修订或归档。"
          href="/researches?judgementDue=true"
          query="scope=published&judgementDue=true"
          icon={<AlarmClock size={18} aria-hidden />}
          render={item => (
            <>
              <span style={{ fontSize: 12, fontWeight: 700, color: 'var(--dr-color-warning)' }}>已过期</span>
              <span style={{ fontSize: 13, color: 'var(--dr-color-text-secondary)' }}>
                {item.judgementDue ? `已过期 ${item.judgementDue.daysOverdue} 天` : '待复查'}
              </span>
            </>
          )}
        />
        <QueueSection
          title="学习待复习"
          description="学习路径的自评里有“不确定”或“不会”的题目。回到原文，先自评再看答案。"
          href="/researches?needsReview=true"
          query="scope=published&needsReview=true"
          icon={<BookOpenCheck size={18} aria-hidden />}
          render={item => (
            <span style={{ fontSize: 13, color: 'var(--dr-color-text-secondary)' }}>
              {item.reviewDue ? `${item.reviewDue.missed} 题未掌握 · ${item.reviewDue.unsure} 题待确认` : '待复习'}
            </span>
          )}
        />
      </div>
      <p style={{ marginTop: 24, color: 'var(--dr-color-text-secondary)', fontSize: 13 }}>
        处理动作在内容详情页完成；这里只负责把“该处理什么”收拢到一个入口。
      </p>
    </div>
  );
}
