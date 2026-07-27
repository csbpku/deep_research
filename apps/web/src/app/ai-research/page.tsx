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

interface SourceRefInput {
  id: string;
  type: 'url' | 'summary' | 'research';
  value: string;
  required: boolean;
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
  const [sourcePolicy, setSourcePolicy] = useState<'prefer_user_sources' | 'only_user_sources'>('prefer_user_sources');
  const [sources, setSources] = useState<SourceRefInput[]>([]);

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
        setSources((current) => current.some((source) => source.type === 'summary' && source.value === seed.id)
          ? current
          : [...current, { id: crypto.randomUUID(), type: 'summary', value: seed.id, required: true }]);
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
    if (sourcePolicy === 'only_user_sources' && !sources.some((source) => source.value.trim())) {
      setErr('only 模式至少需要一条指定资料');
      return;
    }
    setSubmitting(true);
    try {
      const sourceRefs = sources
        .filter((source) => source.value.trim())
        .map((source) => ({ type: source.type, value: source.value.trim(), required: source.required }));
      const r = await fetch('/api/ai-research', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          topic: topic.trim(),
          context: context.trim() || undefined,
          reportType,
          sourcePolicy,
          sourceRefs,
          idempotencyKey: crypto.randomUUID(),
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
          <legend style={{ fontSize: 13, color: '#334155', padding: '0 4px' }}>指定资料（最多 10 条）</legend>
          <p style={{ color: '#64748b', fontSize: 12, marginTop: 0 }}>
            可添加外部 URL、雷达候选（summary UUID）或已发布沉淀（research UUID）。
          </p>
          <div style={{ display: 'grid', gap: 8 }}>
            {sources.map((source) => (
              <div key={source.id} style={{ display: 'grid', gridTemplateColumns: '120px 1fr auto auto', gap: 6, alignItems: 'center' }}>
                <select
                  aria-label="资料类型"
                  value={source.type}
                  disabled={source.type === 'summary' && source.value === seededSummaryId}
                  onChange={(e) => setSources((current) => current.map((item) => item.id === source.id ? { ...item, type: e.target.value as SourceRefInput['type'], value: '' } : item))}
                  style={inputStyle}
                >
                  <option value="url">指定 URL</option>
                  <option value="summary">雷达候选</option>
                  <option value="research">沉淀</option>
                </select>
                <input
                  aria-label="资料地址或 ID"
                  type="text"
                  value={source.value}
                  readOnly={source.type === 'summary' && source.value === seededSummaryId}
                  placeholder={source.type === 'url' ? 'https://example.com/article' : 'UUID'}
                  onChange={(e) => setSources((current) => current.map((item) => item.id === source.id ? { ...item, value: e.target.value } : item))}
                  style={inputStyle}
                />
                <label style={{ fontSize: 12, whiteSpace: 'nowrap' }}>
                  <input type="checkbox" checked={source.required} onChange={(e) => setSources((current) => current.map((item) => item.id === source.id ? { ...item, required: e.target.checked } : item))} /> 必须使用
                </label>
                <button type="button" onClick={() => setSources((current) => current.filter((item) => item.id !== source.id))} style={{ border: 0, background: 'transparent', cursor: 'pointer', color: '#b91c1c' }}>移除</button>
              </div>
            ))}
          </div>
          <button
            type="button"
            disabled={sources.length >= 10}
            onClick={() => setSources((current) => [...current, { id: crypto.randomUUID(), type: 'url', value: '', required: false }])}
            style={{ marginTop: 8, padding: '5px 10px', border: '1px solid #cbd5e1', borderRadius: 4, background: '#fff', cursor: 'pointer' }}
          >
            + 添加资料
          </button>
        </fieldset>

        <fieldset style={{ border: '1px solid #e2e8f0', borderRadius: 8, padding: 12 }}>
          <legend style={{ fontSize: 13, color: '#334155', padding: '0 4px' }}>资料优先级</legend>
          <label style={{ display: 'block', fontSize: 13, marginBottom: 6 }}>
            <input type="radio" name="sourcePolicy" checked={sourcePolicy === 'prefer_user_sources'} onChange={() => setSourcePolicy('prefer_user_sources')} /> 优先使用指定资料，可补充外部搜索（prefer）
          </label>
          <label style={{ display: 'block', fontSize: 13 }}>
            <input type="radio" name="sourcePolicy" checked={sourcePolicy === 'only_user_sources'} onChange={() => setSourcePolicy('only_user_sources')} /> 仅使用指定资料（only）
          </label>
        </fieldset>

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
          当前模式：<code>{sourcePolicy}</code>；已指定 {sources.filter((source) => source.value.trim()).length} 条资料。
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
