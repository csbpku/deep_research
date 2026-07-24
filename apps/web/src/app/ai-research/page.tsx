'use client';

import { useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useEffect, useState } from 'react';
import { EmptyState } from '../../components/EmptyState';

interface ApiError {
  code: string;
  message: string;
  requestId?: string;
}

interface RadarSeed {
  id: string;
  title: string;
  url: string;
  interpretation: string | null;
  body: string | null;
}

const REPORT_TYPES: Array<{ value: 'research_report' | 'summary_brief'; label: string; desc: string }> = [
  {
    value: 'research_report',
    label: '长文调研',
    desc: '5 步流水线（plan → search → compress → analyze → write），生成可编辑的私有草稿。',
  },
  {
    value: 'summary_brief',
    label: '轻量摘要',
    desc: 'Fetch + Compress + Write 轻量路径，不写草稿，结果返回到本页。',
  },
];

function AiResearchForm() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const seedId = searchParams.get('seed');
  const [topic, setTopic] = useState('');
  const [context, setContext] = useState('');
  const [reportType, setReportType] = useState<'research_report' | 'summary_brief'>('research_report');
  const [submitting, setSubmitting] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [seedWarning, setSeedWarning] = useState<string | null>(null);
  const [seededSummaryId, setSeededSummaryId] = useState<string | null>(null);

  useEffect(() => {
    if (!seedId) return;

    let cancelled = false;
    setSeedWarning(null);
    void fetch(`/api/radar/${encodeURIComponent(seedId)}`, { cache: 'no-store' })
      .then(async (response) => {
        if (!response.ok) throw new Error('种子雷达候选不可读');
        return await response.json() as RadarSeed;
      })
      .then((seed) => {
        if (cancelled) return;
        const seedContext = [
          seed.interpretation ?? '',
          `来源: ${seed.url}`,
          '',
          (seed.body ?? '').slice(0, 800),
        ].filter(Boolean).join('\n');
        setTopic(seed.title.slice(0, 200));
        setContext(seedContext.slice(0, 2000));
        setSeededSummaryId(seed.id);
      })
      .catch((seedError: unknown) => {
        if (!cancelled) {
          setSeedWarning(seedError instanceof Error
            ? `预填失败：${seedError.message}，可手动输入`
            : '预填失败，可手动输入');
        }
      });

    return () => {
      cancelled = true;
    };
  }, [seedId]);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setErr(null);
    if (topic.trim().length < 2) {
      setErr('主题至少 2 个字');
      return;
    }
    setSubmitting(true);
    try {
      const sourceRefs = seededSummaryId
        ? [{ type: 'summary' as const, value: seededSummaryId, required: false }]
        : [];
      const r = await fetch('/api/ai-research', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          topic: topic.trim(),
          context: context.trim() || undefined,
          reportType,
          sourcePolicy: seededSummaryId ? 'only_user_sources' : 'prefer_user_sources',
          sourceRefs,
        }),
      });
      if (!r.ok) {
        const body = (await r.json().catch(() => ({ message: '提交失败' }))) as ApiError;
        setErr(`${body.code}: ${body.message}`);
        return;
      }
      const body = (await r.json()) as { jobId: string };
      // 跳详情；前端从 /ai-research/[jobId] 拿状态
      router.push(`/ai-research/${body.jobId}`);
    } catch (e2) {
      setErr(String((e2 as Error).message ?? '提交失败'));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div>
      <h1 style={{ fontSize: 22, margin: '0 0 4px' }}>AI 调研</h1>
      <p style={{ color: '#475569', marginTop: 0 }}>
        输入主题和团队背景；提交后会立刻拿到 job id 然后每 5 秒拉取一次状态。
      </p>

      {seedWarning ? (
        <div
          role="alert"
          style={{
            padding: '8px 12px',
            marginTop: 12,
            borderRadius: 4,
            background: '#fef3c7',
            color: '#92400e',
            fontSize: 13,
          }}
        >
          {seedWarning}
        </div>
      ) : null}

      <form onSubmit={onSubmit} style={{ display: 'grid', gap: 12, maxWidth: 640, marginTop: 16 }}>
        <label style={{ display: 'grid', gap: 4 }}>
          <span style={{ fontSize: 13, color: '#334155' }}>主题 *</span>
          <input
            type="text"
            value={topic}
            onChange={(e) => setTopic(e.target.value)}
            placeholder="例如：RAG 在企业知识库的落地挑战"
            maxLength={200}
            required
            style={inputStyle}
          />
        </label>

        <label style={{ display: 'grid', gap: 4 }}>
          <span style={{ fontSize: 13, color: '#334155' }}>团队背景 / 上下文（可选）</span>
          <textarea
            value={context}
            onChange={(e) => setContext(e.target.value)}
            placeholder="例如：我们是 30 人后端团队，目前用 PostgreSQL + pgvector，正在评估混合检索…"
            maxLength={2000}
            rows={4}
            style={{ ...inputStyle, fontFamily: 'inherit' }}
          />
        </label>

        <fieldset style={{ border: '1px solid #e2e8f0', borderRadius: 8, padding: 12 }}>
          <legend style={{ fontSize: 13, color: '#334155', padding: '0 4px' }}>报告类型</legend>
          {REPORT_TYPES.map((rt) => (
            <label
              key={rt.value}
              style={{
                display: 'flex',
                gap: 8,
                alignItems: 'flex-start',
                padding: '4px 0',
                cursor: 'pointer',
              }}
            >
              <input
                type="radio"
                name="reportType"
                value={rt.value}
                checked={reportType === rt.value}
                onChange={() => setReportType(rt.value)}
                style={{ marginTop: 3 }}
              />
              <span style={{ fontSize: 14 }}>
                <strong>{rt.label}</strong>
                <span style={{ display: 'block', color: '#475569', fontSize: 13 }}>{rt.desc}</span>
              </span>
            </label>
          ))}
        </fieldset>

        <p style={{ fontSize: 12, color: '#64748b', margin: 0 }}>
          {seededSummaryId ? (
            <>已绑定雷达候选，使用 <code>only_user_sources</code>。</>
          ) : (
            <>source_policy 默认 <code>prefer_user_sources</code>。</>
          )}
        </p>

        {err ? (
          <div role="alert" style={{ color: '#b91c1c', fontSize: 13 }}>
            {err}
          </div>
        ) : null}

        <div>
          <button
            type="submit"
            disabled={submitting}
            style={{
              padding: '8px 16px',
              border: '1px solid #0f172a',
              background: submitting ? '#94a3b8' : '#0f172a',
              color: '#fff',
              borderRadius: 4,
              cursor: submitting ? 'not-allowed' : 'pointer',
              fontSize: 14,
            }}
          >
            {submitting ? '提交中…' : '提交调研'}
          </button>
        </div>
      </form>

      <div style={{ marginTop: 24 }}>
        <EmptyState
          title="预算与并发"
          description="团队 20 次/日 + 个人 5 次/日；超出后 ai-engine 返回 429 AI_QUOTA_EXCEEDED。"
        />
      </div>
    </div>
  );
}

export default function AiResearchPage() {
  return (
    <Suspense fallback={<p style={{ color: '#475569' }}>加载调研表单…</p>}>
      <AiResearchForm />
    </Suspense>
  );
}

const inputStyle: React.CSSProperties = {
  padding: '8px 10px',
  border: '1px solid #cbd5e1',
  borderRadius: 4,
  fontSize: 14,
  width: '100%',
  boxSizing: 'border-box',
};
