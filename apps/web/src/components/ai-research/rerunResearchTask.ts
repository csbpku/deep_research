import { writeLastSubmitted } from '@/lib/last-submitted';

export interface RerunnableResearchTask {
  jobId: string;
  topic: string;
  reportType: string;
  reportLength?: 'brief' | 'standard' | 'deep';
  sourcePolicy: string;
  sourceRefs: Array<{ type: string; value: string; required?: boolean }>;
}

interface RerunDetails {
  context?: string | null;
  brief?: Record<string, unknown> | null;
}

export async function rerunResearchTask(item: RerunnableResearchTask): Promise<string> {
  let details: RerunDetails | null = null;
  try {
    const detailResponse = await fetch(`/api/ai-research/${encodeURIComponent(item.jobId)}`, { cache: 'no-store' });
    if (detailResponse.ok) details = await detailResponse.json() as RerunDetails;
  } catch {
    // 列表字段仍足够重跑；详情失败不应阻断恢复入口。
  }

  const preservedBrief = details?.brief && typeof details.brief === 'object'
    ? { ...details.brief, sourcePolicy: item.sourcePolicy }
    : undefined;
  const response = await fetch('/api/ai-research', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      topic: item.topic,
      reportType: item.reportType,
      reportLength: item.reportLength ?? (item.reportType === 'summary_brief' ? 'brief' : 'deep'),
      ...(preservedBrief ? { brief: preservedBrief } : {}),
      ...(details?.context ? { context: details.context } : {}),
      sourcePolicy: item.sourcePolicy,
      sourceRefs: item.sourceRefs,
      idempotencyKey: crypto.randomUUID(),
    }),
  });
  if (!response.ok) {
    const error = (await response.json().catch(() => ({ message: '重新运行失败' }))) as { message?: string };
    throw new Error(error.message ?? `重新运行失败（${response.status}）`);
  }

  const data = await response.json() as { jobId?: string };
  if (!data.jobId) throw new Error('重新运行未返回任务 ID');
  writeLastSubmitted(data.jobId, item.topic);
  return data.jobId;
}
