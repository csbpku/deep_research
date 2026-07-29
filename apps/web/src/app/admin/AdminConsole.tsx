'use client';

// Admin 控制台客户端组件 —— Week 8：仪表板 + 3 个审核队列。
// 由 app/admin/page.tsx（Server Component）做鉴权拦截后渲染。

import { useState } from 'react';
import Link from 'next/link';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import type { RadarFeedbackCounts } from '../../components/radar/RadarFeedbackBar';

type Tab = 'dashboard' | 'radar' | 'shares' | 'comments';

const TABS: { key: Tab; label: string }[] = [
  { key: 'dashboard', label: '📊 仪表板' },
  { key: 'radar', label: '🛰️ 雷达候选' },
  { key: 'shares', label: '🔗 用户分享' },
  { key: 'comments', label: '💡 评论提名' },
];

interface DashboardData {
  pendingReviews: { total: number; shares: number; radarCandidates: number; commentNominations: number };
  content: { newResearchesThisWeek: number };
  jobs: { submittedLast24h: number; failedLast24h: number; failedImportJobs: number };
  cost: { monthUsdCents: number; monthUsd: string };
  radar: {
    lastSync: null | {
      id: string;
      source: { name: string; sourceType: string } | null;
      status: string;
      completedAt: string | null;
      createdAt: string;
      errorCode: string | null;
    };
    failedRunsLast24h: number;
  };
  generatedAt: string;
}

interface RadarItem {
  id: string;
  title: string;
  excerpt: string;
  url: string;
  sourceType: string | null;
  tags: string[];
  status: string;
  interpretation: string | null;
  publishedAt: string | null;
  crawledAt: string;
  feedbackCounts: RadarFeedbackCounts;
}

interface RadarListResponse {
  page: number;
  perPage: number;
  total: number;
  totalPages: number;
  items: RadarItem[];
}

interface ShareItem {
  id: string;
  url: string;
  canonicalUrl: string;
  userNote: string | null;
  fetchedTitle: string | null;
  summaryText: string | null;
  fetchErrorCode: string | null;
  status: 'pending' | 'approved' | 'rejected';
  createdAt: string;
  completedAt: string | null;
  submitter: { id: string; name: string; email: string };
  reviewer: { id: string; name: string } | null;
}

interface ShareListResponse {
  page: number;
  perPage: number;
  total: number;
  totalPages: number;
  items: ShareItem[];
}

interface CommentItem {
  id: string;
  body: string;
  starCount: number;
  promoteStatus: 'none' | 'nominated' | 'approved' | 'rejected';
  targetType: 'research' | 'summary';
  summary: { id: string; title: string } | null;
  research: { id: string; title: string } | null;
  createdAt: string;
  author: { id: string; name: string; email: string };
}

interface CommentListResponse {
  page: number;
  perPage: number;
  total: number;
  totalPages: number;
  items: CommentItem[];
}

export default function AdminConsole() {
  const [tab, setTab] = useState<Tab>('dashboard');
  return (
    <div style={{ maxWidth: 960, margin: '0 auto', padding: '24px 20px' }}>
      <header style={{ marginBottom: 16 }}>
        <h1 style={{ fontSize: 24, margin: '0 0 4px', color: '#dc2626' }}>🛡️ Admin 控制台</h1>
        <p style={{ fontSize: 13, color: '#64748b', margin: 0 }}>
          管理内容质量、监控平台健康度。仅 admin 角色可见。
        </p>
      </header>

      <nav style={{ display: 'flex', gap: 4, borderBottom: '1px solid #e2e8f0', marginBottom: 16, overflowX: 'auto' }}>
        {TABS.map((t) => (
          <button
            key={t.key}
            type="button"
            onClick={() => setTab(t.key)}
            style={{
              padding: '8px 14px',
              fontSize: 13,
              background: 'transparent',
              border: 'none',
              borderBottom: tab === t.key ? '2px solid #0f172a' : '2px solid transparent',
              color: tab === t.key ? '#0f172a' : '#64748b',
              cursor: 'pointer',
              fontWeight: tab === t.key ? 600 : 400,
              whiteSpace: 'nowrap',
            }}
          >
            {t.label}
          </button>
        ))}
      </nav>

      {tab === 'dashboard' && <DashboardTab />}
      {tab === 'radar' && <RadarTab />}
      {tab === 'shares' && <SharesTab />}
      {tab === 'comments' && <CommentsTab />}
    </div>
  );
}

// ──────────────────────────────────────────────────────────────────────
// 仪表板
// ──────────────────────────────────────────────────────────────────────

function DashboardTab() {
  const q = useQuery<DashboardData>({
    queryKey: ['admin-dashboard'],
    queryFn: async () => {
      const r = await fetch('/api/admin/dashboard', { cache: 'no-store' });
      if (!r.ok) throw new Error('加载失败');
      return r.json();
    },
    refetchInterval: 30_000,
  });

  if (q.isLoading) return <p style={{ color: '#94a3b8' }}>加载中…</p>;
  if (q.isError || !q.data) return <p style={{ color: '#dc2626' }}>{(q.error as Error)?.message ?? '加载失败'}</p>;

  const d = q.data;
  const cardStyle: React.CSSProperties = {
    background: '#fff',
    border: '1px solid #e2e8f0',
    borderRadius: 8,
    padding: 16,
  };

  return (
    <div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: 12, marginBottom: 16 }}>
        <StatCard
          label="⏳ 待审核"
          value={d.pendingReviews.total}
          sub={`分享 ${d.pendingReviews.shares} · 候选 ${d.pendingReviews.radarCandidates} · 提名 ${d.pendingReviews.commentNominations}`}
          color={d.pendingReviews.total > 0 ? '#dc2626' : '#0f172a'}
        />
        <StatCard
          label="📚 本周新增"
          value={d.content.newResearchesThisWeek}
          sub="已发布沉淀"
        />
        <StatCard
          label="🤖 AI 调研"
          value={`${d.jobs.submittedLast24h} / 24h`}
          sub={`失败 ${d.jobs.failedLast24h} · 导入失败 ${d.jobs.failedImportJobs}`}
          color={d.jobs.failedLast24h > 0 ? '#d97706' : '#0f172a'}
        />
        <StatCard
          label="💰 本月成本"
          value={`$${d.cost.monthUsd}`}
          sub="AI 调研"
          color={Number(d.cost.monthUsd) > 50 ? '#d97706' : '#0f172a'}
        />
      </div>

      <section style={cardStyle}>
        <h3 style={{ fontSize: 14, fontWeight: 600, margin: '0 0 12px', color: '#0f172a' }}>🛰️ 雷达同步状态</h3>
        {d.radar.lastSync ? (
          <div style={{ fontSize: 13, color: '#475569' }}>
            <p style={{ margin: '0 0 4px' }}>
              最近同步：
              <strong style={{ color: '#0f172a' }}>{d.radar.lastSync.source?.name ?? '未知源'}</strong>
              （{d.radar.lastSync.source?.sourceType ?? '?'}）
            </p>
            <p style={{ margin: '0 0 4px' }}>
              状态：
              <SyncStatusBadge status={d.radar.lastSync.status} />
              {' · '}
              <span style={{ color: '#94a3b8' }}>
                {new Date(d.radar.lastSync.completedAt ?? d.radar.lastSync.createdAt).toLocaleString('zh-CN')}
              </span>
            </p>
            {d.radar.lastSync.errorCode && (
              <p style={{ margin: '0 0 4px', color: '#dc2626' }}>错误码：{d.radar.lastSync.errorCode}</p>
            )}
            <p style={{ margin: '4px 0 0', fontSize: 12, color: '#94a3b8' }}>
              过去 24h 失败同步次数：<strong style={{ color: d.radar.failedRunsLast24h > 0 ? '#dc2626' : '#0f172a' }}>{d.radar.failedRunsLast24h}</strong>
            </p>
          </div>
        ) : (
          <p style={{ fontSize: 13, color: '#94a3b8', margin: 0 }}>暂无同步记录</p>
        )}
      </section>

      <p style={{ marginTop: 16, fontSize: 11, color: '#94a3b8' }}>
        数据生成时间：{new Date(d.generatedAt).toLocaleString('zh-CN')} · 每 30s 自动刷新
      </p>
    </div>
  );
}

function StatCard({ label, value, sub, color }: { label: string; value: number | string; sub?: string; color?: string }) {
  return (
    <div style={{ background: '#fff', border: '1px solid #e2e8f0', borderRadius: 8, padding: 16 }}>
      <div style={{ fontSize: 12, color: '#64748b', marginBottom: 4 }}>{label}</div>
      <div style={{ fontSize: 26, fontWeight: 700, color: color ?? '#0f172a' }}>{value}</div>
      {sub && <div style={{ fontSize: 11, color: '#94a3b8', marginTop: 4 }}>{sub}</div>}
    </div>
  );
}

function SyncStatusBadge({ status }: { status: string }) {
  return <span style={{ padding: '2px 8px', background: syncStatusStyle(status).bg, color: syncStatusStyle(status).fg, fontSize: 11, borderRadius: 4, fontWeight: 600, marginLeft: 4 }}>{syncStatusStyle(status).label}</span>;
}

/** Pure helper: returns label + colors for a radar sync status. Exposed for tests. */
export function syncStatusStyle(status: string): { label: string; bg: string; fg: string } {
  const map: Record<string, { label: string; bg: string; fg: string }> = {
    running: { label: '运行中', bg: '#dbeafe', fg: '#1d4ed8' },
    completed: { label: '完成', bg: '#dcfce7', fg: '#15803d' },
    partial: { label: '部分', bg: '#fef3c7', fg: '#92400e' },
    failed: { label: '失败', bg: '#fee2e2', fg: '#b91c1c' },
  };
  return map[status] ?? { label: status, bg: '#f1f5f9', fg: '#475569' };
}

// ──────────────────────────────────────────────────────────────────────
// 雷达候选（简化版列表入口；详细操作仍走 /admin/radar）
// ──────────────────────────────────────────────────────────────────────

function RadarTab() {
  const [status, setStatus] = useState('candidate');
  const [page, setPage] = useState(1);

  const q = useQuery<RadarListResponse>({
    queryKey: ['admin-radar-tab', status, page],
    queryFn: async () => {
      const params = new URLSearchParams();
      params.set('status', status);
      params.set('page', String(page));
      params.set('per_page', '20');
      const r = await fetch(`/api/admin/radar?${params.toString()}`, { cache: 'no-store' });
      if (!r.ok) throw new Error('加载失败');
      return r.json();
    },
  });

  return (
    <div>
      <div style={{ display: 'flex', gap: 8, marginBottom: 12 }}>
        {['candidate', 'published', 'rejected', 'archived'].map((s) => (
          <button
            key={s}
            type="button"
            onClick={() => { setStatus(s); setPage(1); }}
            style={{
              padding: '4px 12px', fontSize: 12,
              background: status === s ? '#0f172a' : '#fff',
              color: status === s ? '#fff' : '#475569',
              border: '1px solid #cbd5e1', borderRadius: 4, cursor: 'pointer',
            }}
          >
            {s === 'candidate' ? '候选' : s === 'published' ? '已发布' : s === 'rejected' ? '已忽略' : '已归档'}
          </button>
        ))}
        <div style={{ marginLeft: 'auto', fontSize: 12, color: '#64748b' }}>
          共 {q.data?.total ?? '?'} 条 · <Link href="/admin/radar" style={{ color: '#0ea5e9' }}>打开完整管理 →</Link>
        </div>
      </div>

      {q.isLoading && <p style={{ color: '#94a3b8' }}>加载中…</p>}
      {q.isError && <p style={{ color: '#dc2626' }}>{(q.error as Error).message}</p>}

      <ul style={{ listStyle: 'none', padding: 0, margin: 0, display: 'grid', gap: 8 }}>
        {(q.data?.items ?? []).map((it) => (
          <li key={it.id} style={{ padding: 12, border: '1px solid #e2e8f0', borderRadius: 6, background: '#fff' }}>
            <Link href={`/admin/radar/${it.id}`} style={{ display: 'block', color: '#0f172a', textDecoration: 'none', fontWeight: 500 }}>
              {it.title}
            </Link>
            <div style={{ fontSize: 11, color: '#94a3b8', marginTop: 4 }}>
              {it.sourceType ?? '?'} · {new Date(it.crawledAt).toLocaleDateString('zh-CN')}
              {it.interpretation && ` · ${it.interpretation.slice(0, 60)}…`}
            </div>
          </li>
        ))}
      </ul>

      {q.data && q.data.totalPages > 1 && (
        <div style={{ display: 'flex', justifyContent: 'center', gap: 4, marginTop: 16 }}>
          <button disabled={page <= 1} onClick={() => setPage((p) => p - 1)} style={pageBtnStyle}>‹</button>
          <span style={{ padding: '4px 8px', fontSize: 13 }}>{page} / {q.data.totalPages}</span>
          <button disabled={page >= q.data.totalPages} onClick={() => setPage((p) => p + 1)} style={pageBtnStyle}>›</button>
        </div>
      )}
    </div>
  );
}

const pageBtnStyle: React.CSSProperties = {
  padding: '4px 12px', background: '#fff', border: '1px solid #cbd5e1',
  borderRadius: 4, cursor: 'pointer', fontSize: 13,
};

// ──────────────────────────────────────────────────────────────────────
// 用户分享审核
// ──────────────────────────────────────────────────────────────────────

function SharesTab() {
  const [status, setStatus] = useState<'pending' | 'approved' | 'rejected'>('pending');
  const [page, setPage] = useState(1);
  const queryClient = useQueryClient();

  const q = useQuery<ShareListResponse>({
    queryKey: ['admin-shares', status, page],
    queryFn: async () => {
      const params = new URLSearchParams({ status, page: String(page), per_page: '20' });
      const r = await fetch(`/api/admin/shares?${params.toString()}`, { cache: 'no-store' });
      if (!r.ok) throw new Error('加载失败');
      return r.json();
    },
  });

  const reviewMut = useMutation({
    mutationFn: async (input: { id: string; action: 'approve' | 'reject'; reason?: string }) => {
      const r = await fetch(`/api/admin/shares/${input.id}/review`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ action: input.action, reason: input.reason ?? '审核拒绝' }),
      });
      if (!r.ok) {
        const err = await r.json().catch(() => ({ message: '操作失败' }));
        throw new Error((err as { message?: string }).message ?? '操作失败');
      }
      return r.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['admin-shares'] });
      queryClient.invalidateQueries({ queryKey: ['admin-dashboard'] });
    },
  });

  return (
    <div>
      <div style={{ display: 'flex', gap: 8, marginBottom: 12 }}>
        {(['pending', 'approved', 'rejected'] as const).map((s) => (
          <button
            key={s}
            type="button"
            onClick={() => { setStatus(s); setPage(1); }}
            style={{
              padding: '4px 12px', fontSize: 12,
              background: status === s ? '#0f172a' : '#fff',
              color: status === s ? '#fff' : '#475569',
              border: '1px solid #cbd5e1', borderRadius: 4, cursor: 'pointer',
            }}
          >
            {s === 'pending' ? '待审核' : s === 'approved' ? '已批准' : '已拒绝'}
          </button>
        ))}
        <div style={{ marginLeft: 'auto', fontSize: 12, color: '#64748b' }}>
          共 {q.data?.total ?? '?'} 条
        </div>
      </div>

      {q.isLoading && <p style={{ color: '#94a3b8' }}>加载中…</p>}
      {q.isError && <p style={{ color: '#dc2626' }}>{(q.error as Error).message}</p>}

      <ul style={{ listStyle: 'none', padding: 0, margin: 0, display: 'grid', gap: 10 }}>
        {(q.data?.items ?? []).map((it) => (
          <li key={it.id} style={{ padding: 14, border: '1px solid #e2e8f0', borderRadius: 6, background: '#fff' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 12 }}>
              <div style={{ flex: 1, minWidth: 0 }}>
                <h4 style={{ margin: '0 0 4px', fontSize: 14, fontWeight: 600 }}>
                  <a href={it.url} target="_blank" rel="noopener noreferrer" style={{ color: '#0f172a', textDecoration: 'none' }}>
                    {it.fetchedTitle ?? it.url}
                  </a>
                </h4>
                <p style={{ margin: '0 0 4px', fontSize: 11, color: '#94a3b8' }}>
                  分享人：{it.submitter.name} ({it.submitter.email}) · {new Date(it.createdAt).toLocaleString('zh-CN')}
                </p>
                {it.userNote && (
                  <p style={{ margin: '4px 0', fontSize: 12, color: '#475569', background: '#f8fafc', padding: '4px 8px', borderRadius: 4 }}>
                    💬 {it.userNote}
                  </p>
                )}
                {it.summaryText && (
                  <details style={{ marginTop: 6 }}>
                    <summary style={{ fontSize: 11, color: '#0ea5e9', cursor: 'pointer' }}>查看 AI 摘要</summary>
                    <p style={{ fontSize: 12, color: '#475569', margin: '4px 0 0', whiteSpace: 'pre-wrap', lineHeight: 1.6 }}>
                      {it.summaryText.slice(0, 500)}
                      {it.summaryText.length > 500 && '…'}
                    </p>
                  </details>
                )}
                {it.fetchErrorCode && (
                  <p style={{ fontSize: 11, color: '#dc2626', margin: '4px 0 0' }}>
                    ⚠️ 抓取失败：{it.fetchErrorCode}
                  </p>
                )}
              </div>
              {status === 'pending' && (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 6, flexShrink: 0 }}>
                  <button
                    type="button"
                    disabled={reviewMut.isPending || !it.summaryText}
                    onClick={() => reviewMut.mutate({ id: it.id, action: 'approve' })}
                    style={approveBtnStyle}
                  >
                    ✓ 批准
                  </button>
                  <button
                    type="button"
                    disabled={reviewMut.isPending}
                    onClick={() => {
                      const reason = prompt('拒绝原因：');
                      if (reason) reviewMut.mutate({ id: it.id, action: 'reject', reason });
                    }}
                    style={rejectBtnStyle}
                  >
                    ✗ 拒绝
                  </button>
                </div>
              )}
            </div>
          </li>
        ))}
      </ul>

      {reviewMut.isError && (
        <p style={{ color: '#dc2626', fontSize: 12, marginTop: 8 }}>
          操作失败：{(reviewMut.error as Error).message}
        </p>
      )}
    </div>
  );
}

const approveBtnStyle: React.CSSProperties = {
  padding: '4px 12px', background: '#15803d', color: '#fff',
  border: 'none', borderRadius: 4, fontSize: 12, cursor: 'pointer',
};

const rejectBtnStyle: React.CSSProperties = {
  padding: '4px 12px', background: '#fff', color: '#b91c1c',
  border: '1px solid #fca5a5', borderRadius: 4, fontSize: 12, cursor: 'pointer',
};

// ──────────────────────────────────────────────────────────────────────
// 评论提名
// ──────────────────────────────────────────────────────────────────────

function CommentsTab() {
  const [status, setStatus] = useState<'pending' | 'approved' | 'rejected' | 'all'>('pending');
  const queryClient = useQueryClient();

  const q = useQuery<CommentListResponse>({
    queryKey: ['admin-comments', status],
    queryFn: async () => {
      const params = new URLSearchParams({ status, page: '1', per_page: '30' });
      const r = await fetch(`/api/admin/comments?${params.toString()}`, { cache: 'no-store' });
      if (!r.ok) throw new Error('加载失败');
      return r.json();
    },
  });

  const promoteMut = useMutation({
    mutationFn: async (input: { id: string; title: string; body: string; tags: string[] }) => {
      const r = await fetch(`/api/admin/comments/${input.id}/promote`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ title: input.title, body: input.body, tags: input.tags }),
      });
      if (!r.ok) {
        const err = await r.json().catch(() => ({ message: '提炼失败' }));
        throw new Error((err as { message?: string }).message ?? '提炼失败');
      }
      return r.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['admin-comments'] });
      queryClient.invalidateQueries({ queryKey: ['admin-dashboard'] });
    },
  });

  const dismissMut = useMutation({
    mutationFn: async (input: { id: string; reason: string }) => {
      const r = await fetch(`/api/admin/comments/${input.id}/dismiss`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ reason: input.reason }),
      });
      if (!r.ok) {
        const err = await r.json().catch(() => ({ message: '拒绝失败' }));
        throw new Error((err as { message?: string }).message ?? '拒绝失败');
      }
      return r.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['admin-comments'] });
      queryClient.invalidateQueries({ queryKey: ['admin-dashboard'] });
    },
  });

  return (
    <div>
      <div style={{ display: 'flex', gap: 8, marginBottom: 12 }}>
        {(['pending', 'approved', 'rejected', 'all'] as const).map((s) => (
          <button
            key={s}
            type="button"
            onClick={() => setStatus(s)}
            style={{
              padding: '4px 12px', fontSize: 12,
              background: status === s ? '#0f172a' : '#fff',
              color: status === s ? '#fff' : '#475569',
              border: '1px solid #cbd5e1', borderRadius: 4, cursor: 'pointer',
            }}
          >
            {s === 'pending' ? '待提炼' : s === 'approved' ? '已提炼' : s === 'rejected' ? '已拒绝' : '全部'}
          </button>
        ))}
        <div style={{ marginLeft: 'auto', fontSize: 12, color: '#64748b' }}>
          共 {q.data?.total ?? '?'} 条
        </div>
      </div>

      {q.isLoading && <p style={{ color: '#94a3b8' }}>加载中…</p>}
      {q.isError && <p style={{ color: '#dc2626' }}>{(q.error as Error).message}</p>}

      <ul style={{ listStyle: 'none', padding: 0, margin: 0, display: 'grid', gap: 10 }}>
        {(q.data?.items ?? []).map((it) => (
          <li key={it.id} style={{ padding: 14, border: '1px solid #e2e8f0', borderRadius: 6, background: '#fff' }}>
            <p style={{ margin: '0 0 4px', fontSize: 11, color: '#94a3b8' }}>
              <strong style={{ color: '#0f172a' }}>{it.author.name}</strong> ({it.author.email}) · {new Date(it.createdAt).toLocaleString('zh-CN')} · ⭐ {it.starCount}
              {it.targetType === 'summary' && it.summary && (
                <> · 来自摘要: <Link href={`/summaries/${it.summary.id}`} style={{ color: '#0ea5e9' }}>{it.summary.title}</Link></>
              )}
              {it.targetType === 'research' && it.research && (
                <> · 来自沉淀: <Link href={`/researches/${it.research.id}`} style={{ color: '#0ea5e9' }}>{it.research.title}</Link></>
              )}
            </p>
            <blockquote style={{
              margin: '8px 0', padding: '8px 12px',
              background: '#f8fafc', borderLeft: '3px solid #0f172a',
              borderRadius: 4, fontSize: 13, color: '#1e293b', lineHeight: 1.6,
            }}>
              {it.body}
            </blockquote>
            {it.promoteStatus === 'nominated' && (
              <div style={{ display: 'flex', gap: 8 }}>
                <button
                  type="button"
                  disabled={promoteMut.isPending || dismissMut.isPending}
                  onClick={() => {
                    const title = prompt('精华标题：', it.body.slice(0, 30));
                    if (!title) return;
                    promoteMut.mutate({ id: it.id, title, body: it.body, tags: [] });
                  }}
                  style={approveBtnStyle}
                >
                  ✨ 提炼为精华
                </button>
                <button
                  type="button"
                  disabled={dismissMut.isPending}
                  onClick={() => {
                    const reason = prompt('拒绝原因：');
                    if (reason) dismissMut.mutate({ id: it.id, reason });
                  }}
                  style={rejectBtnStyle}
                >
                  ✗ 拒绝
                </button>
              </div>
            )}
            {it.promoteStatus === 'approved' && (
              <p style={{ fontSize: 12, color: '#15803d', margin: 0 }}>✅ 已提炼为精华</p>
            )}
            {it.promoteStatus === 'rejected' && (
              <p style={{ fontSize: 12, color: '#94a3b8', margin: 0 }}>已拒绝</p>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}