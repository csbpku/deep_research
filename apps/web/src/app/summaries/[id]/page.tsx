'use client';

import { useQuery } from '@tanstack/react-query';
import Link from 'next/link';
import { useEffect, useRef, useState } from 'react';
import { EmptyState } from '../../../components/EmptyState.js';

interface SummaryDetail {
  id: string;
  title: string;
  body: string;
  url: string;
  tags: string[];
  contentOrigin: string;
  summaryDate: string;
  publishedAt: string | null;
  crawledAt: string;
  source: string;
  sharedBy: { id: string; name: string } | null;
}

/**
 * 详情页。
 *
 * 验收：
 *   - 外部链接 `rel="noopener noreferrer"` + `target="_blank"`
 *   - 标题、摘要、标签、原文 URL、来源类型、抓取时间
 *   - 预留评论 / 追问区域（本周 W3+ 才实现交互）
 *   - 30s 前台 + 50% 滚动双条件 → POST /api/events/detail-read
 */
export default function SummaryDetailPage({ params }: { params: { id: string } }) {
  const q = useQuery<SummaryDetail>({
    queryKey: ['summary', params.id],
    queryFn: async () => {
      const r = await fetch(`/api/summaries/${params.id}`, { cache: 'no-store' });
      if (!r.ok) {
        const err = await r.json().catch(() => ({ message: '加载失败' }));
        throw new Error(err.message ?? '加载失败');
      }
      return (await r.json()) as SummaryDetail;
    },
  });

  return (
    <div>
      <Link href="/summaries" style={{ fontSize: 13, color: '#475569' }}>
        ← 返回摘要列表
      </Link>

      {q.isLoading ? (
        <p style={{ color: '#475569', marginTop: 16 }}>加载中…</p>
      ) : q.isError ? (
        <div style={{ marginTop: 16 }}>
          <EmptyState title="加载失败" description={String((q.error as Error).message)} />
        </div>
      ) : q.data ? (
        <DetailBody data={q.data} />
      ) : null}
    </div>
  );
}

function DetailBody({ data }: { data: SummaryDetail }) {
  // 详情可见后开始跟踪指标；卸载 / 离开时停止
  const articleRef = useRef<HTMLElement | null>(null);
  const eventState = useDetailReadTracker(data.id, 'summary', articleRef);

  return (
    <article ref={articleRef} style={{ marginTop: 16, lineHeight: 1.65 }}>
      <h1 style={{ fontSize: 26, marginTop: 0, marginBottom: 8 }}>{data.title}</h1>
      <Meta data={data} />

      {data.tags.length > 0 ? (
        <div style={{ margin: '12px 0', display: 'flex', flexWrap: 'wrap', gap: 6 }}>
          {data.tags.map((t) => (
            <span
              key={t}
              style={{
                padding: '2px 10px',
                borderRadius: 12,
                background: '#f1f5f9',
                color: '#334155',
                fontSize: 12,
              }}
            >
              #{t}
            </span>
          ))}
        </div>
      ) : null}

      <div
        style={{
          whiteSpace: 'pre-wrap',
          color: '#1e293b',
          fontSize: 15,
          margin: '12px 0 24px',
        }}
      >
        {data.body}
      </div>

      <a
        href={data.url}
        target="_blank"
        rel="noopener noreferrer"
        style={{
          display: 'inline-block',
          padding: '8px 14px',
          border: '1px solid #0f172a',
          background: '#0f172a',
          color: '#fff',
          borderRadius: 4,
          textDecoration: 'none',
          fontSize: 14,
        }}
      >
        打开原文 ↗
      </a>

      {/* W3+ 区域 */}
      <section
        style={{
          marginTop: 32,
          padding: 16,
          border: '1px dashed #cbd5e1',
          borderRadius: 8,
          background: '#f8fafc',
          color: '#475569',
          fontSize: 14,
        }}
        aria-label="评论与追问区（占位）"
      >
        <strong style={{ color: '#0f172a' }}>评论与追问</strong>
        <p style={{ margin: '4px 0 0' }}>
          Week 3+ 启用评论与追问交互。当前页面会记录你的阅读行为（停留 ≥30 秒且滚动 ≥50% 时上报）。
        </p>
        <p style={{ margin: '4px 0 0', fontSize: 12 }}>
          状态：{eventState.label}
          {eventState.submitted ? ' · 已上报' : eventState.eligible ? ' · 待提交' : ''}
        </p>
      </section>
    </article>
  );
}

function Meta({ data }: { data: SummaryDetail }) {
  const fmt = (iso: string | null) =>
    iso ? new Date(iso).toISOString().replace('T', ' ').slice(0, 16) + ' UTC' : '—';
  return (
    <div style={{ color: '#64748b', fontSize: 13, marginBottom: 8 }}>
      来源 <code style={{ background: '#f1f5f9', padding: '0 4px', borderRadius: 3 }}>{data.contentOrigin}</code>
      {' · '}
      抓取时间 {fmt(data.crawledAt)}
      {' · '}
      发布日期 {data.summaryDate}
      {data.publishedAt ? ` · 发布时间 ${fmt(data.publishedAt)}` : ''}
      {data.sharedBy ? ` · 分享人 ${data.sharedBy.name}` : ''}
    </div>
  );
}

/**
 * 跟踪详情页停留 / 滚动，达成条件后提交 detail_read_completed。
 *
 * 返回仅用于 UI 显示；不阻塞。
 *
 * 状态机：
 *   idle → foregroundActive → eligible (≥30s 且 ≥50%) → submit → done
 *   visibilitychange / pagehide → pause / cancel submit
 */
function useDetailReadTracker(
  entityId: string,
  entityType: 'summary' | 'research',
  articleRef: React.RefObject<HTMLElement | null>,
): { label: string; submitted: boolean; eligible: boolean } {
  const [state, setState] = useState<{
    label: string;
    submitted: boolean;
    eligible: boolean;
  }>({ label: '跟踪中…', submitted: false, eligible: false });

  useEffect(() => {
    let cancelled = false;
    let submitted = false;
    let foregroundMs = 0;
    let maxScrollPercent = 0;
    let lastTick = Date.now();
    let tickHandle: ReturnType<typeof setInterval> | null = null;
    let eligible = false;

    function recompute() {
      const seconds = Math.floor(foregroundMs / 1000);
      const secOk = seconds >= 30;
      const scrollOk = maxScrollPercent >= 50;
      const isEligible = secOk && scrollOk;
      if (isEligible && !eligible) {
        eligible = true;
        setState((s) => ({ ...s, eligible: true, label: `已满足条件（停留 ${seconds}s · 滚动 ${maxScrollPercent.toFixed(0)}%）` }));
      }
      if (!submitted && isEligible) {
        submit();
      } else if (!isEligible) {
        setState((s) => ({ ...s, label: `跟踪中（停留 ${seconds}s · 滚动 ${maxScrollPercent.toFixed(0)}%）` }));
      }
    }

    function tick() {
      if (document.visibilityState !== 'visible') {
        lastTick = Date.now();
        return;
      }
      const now = Date.now();
      foregroundMs += now - lastTick;
      lastTick = now;
      // 重新计算滚动比例（窗口滚动 + 文章本体滚动都算）
      const scrollY = window.scrollY + window.innerHeight;
      const maxY = document.documentElement.scrollHeight;
      const pct = maxY > 0 ? Math.min(100, (scrollY / maxY) * 100) : 0;
      if (pct > maxScrollPercent) maxScrollPercent = pct;
      recompute();
    }

    function onVisibility() {
      const now = Date.now();
      if (document.visibilityState === 'visible') {
        lastTick = now;
      } else {
        foregroundMs += now - lastTick;
        lastTick = now;
        recompute();
      }
    }

    function onScroll() {
      const scrollY = window.scrollY + window.innerHeight;
      const maxY = document.documentElement.scrollHeight;
      const pct = maxY > 0 ? Math.min(100, (scrollY / maxY) * 100) : 0;
      if (pct > maxScrollPercent) maxScrollPercent = pct;
      if (eligible && !submitted) {
        // 滚动追加达 50% 也立即触发
        recompute();
      }
    }

    async function submit() {
      if (submitted || cancelled) return;
      const seconds = Math.floor(foregroundMs / 1000);
      const scroll = Math.round(maxScrollPercent);
      const idempotencyKey = cryptoUuid();
      try {
        const r = await fetch('/api/events/detail-read', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            entityType,
            entityId,
            foregroundSeconds: seconds,
            scrollPercent: scroll,
            idempotencyKey,
          }),
        });
        if (cancelled) return;
        if (r.ok) {
          const body = await r.json().catch(() => ({}));
          submitted = true;
          setState((s) => ({
            ...s,
            submitted: !body.deduplicated,
            label: body.deduplicated ? '本周已记录过同一阅读' : '已上报',
          }));
        } else {
          setState((s) => ({ ...s, label: '上报失败，可忽略（不阻断阅读）' }));
        }
      } catch {
        setState((s) => ({ ...s, label: '上报失败，可忽略（不阻断阅读）' }));
      }
    }

    // 1s 节奏 tick；scroll 事件补帧
    lastTick = Date.now();
    tickHandle = setInterval(tick, 1000);
    document.addEventListener('visibilitychange', onVisibility);
    window.addEventListener('scroll', onScroll, { passive: true });
    window.addEventListener('pagehide', () => {
      cancelled = true;
    });

    return () => {
      cancelled = true;
      if (tickHandle) clearInterval(tickHandle);
      document.removeEventListener('visibilitychange', onVisibility);
      window.removeEventListener('scroll', onScroll);
      // 读 articleRef.current 仅用于调试；避免 lint 警告
      void articleRef;
    };
  }, [entityId, entityType, articleRef]);

  return state;
}

function cryptoUuid(): string {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const g: any = globalThis;
  if (g.crypto?.randomUUID) return g.crypto.randomUUID();
  const rnd = () => Math.floor(Math.random() * 0x10000).toString(16).padStart(4, '0');
  return `${rnd()}${rnd()}-${rnd()}-4${rnd().slice(1)}-${rnd()}-${rnd()}${rnd()}${rnd()}`;
}
