import type { BriefValue } from '@/components/ai-research/AiResearchBrief';

export type ResearchDraft = {
  reportType: 'research_report' | 'summary_brief' | 'slides' | 'web_brief';
  reportLength: 'brief' | 'standard' | 'deep';
  sourcePolicy: 'prefer_user_sources' | 'only_user_sources';
  sourceUrls: string[];
  sourceDraft: string;
  input: string;
  seed: { id: string; title: string; url: string; interpretation: string | null; body: string | null } | null;
  brief: BriefValue | null;
};
type DraftStorage = Pick<Storage, 'getItem' | 'setItem'>;
const keyFor = (userId: string, conversationId: string) => `ai-research-draft:v1:${userId}:${conversationId}`;

export function formatResearchRelativeTime(iso: string | null, now = Date.now()): string {
  if (!iso) return '时间未知';
  const diff = now - Date.parse(iso);
  if (!Number.isFinite(diff)) return '时间未知';
  if (diff < 60_000) return '刚刚';
  const min = Math.floor(diff / 60_000);
  if (min < 60) return `${min} 分钟前`;
  const hour = Math.floor(min / 60);
  if (hour < 24) return `${hour} 小时前`;
  const day = Math.floor(hour / 24);
  if (day < 30) return `${day} 天前`;
  return `${Math.floor(day / 30)} 个月前`;
}

/** Display-only protocol cleanup; source text and evidence records stay unchanged. */
export function stripResearchCitationMarkers(content: string): string {
  return content.replace(/\[\[\/?cite\]\]/giu, '');
}

function isDraft(value: unknown): value is ResearchDraft {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const v = value as Record<string, unknown>;
  if (!['research_report', 'summary_brief', 'slides', 'web_brief'].includes(String(v.reportType)) ||
      !['brief', 'standard', 'deep'].includes(String(v.reportLength)) ||
      !['prefer_user_sources', 'only_user_sources'].includes(String(v.sourcePolicy)) ||
      !Array.isArray(v.sourceUrls) || v.sourceUrls.length > 10 ||
      !v.sourceUrls.every((url) => typeof url === 'string' && url.length <= 2048 && /^https?:\/\//iu.test(url)) ||
      typeof v.sourceDraft !== 'string' || v.sourceDraft.length > 2048 || typeof v.input !== 'string' || v.input.length > 20000) return false;
  if (v.seed !== null && v.seed !== undefined) {
    if (!v.seed || typeof v.seed !== 'object' || Array.isArray(v.seed)) return false;
    const seed = v.seed as Record<string, unknown>;
    if (typeof seed.id !== 'string' || typeof seed.title !== 'string' || typeof seed.url !== 'string' ||
        !(seed.interpretation === null || typeof seed.interpretation === 'string') ||
        !(seed.body === null || typeof seed.body === 'string')) return false;
  }
  if (v.brief === null) return true;
  if (!v.brief || typeof v.brief !== 'object' || Array.isArray(v.brief)) return false;
  const b = v.brief as Record<string, unknown>;
  const detail = b.brief as Record<string, unknown> | undefined;
  return ['explore', 'learn', 'investigate', 'decide'].includes(String(b.objective)) &&
    typeof b.assistantMessage === 'string' && Array.isArray(b.suggestedContextIds) &&
    b.suggestedContextIds.every((id) => typeof id === 'string') &&
    !!detail && typeof detail === 'object' && typeof detail.question === 'string' &&
    ['questionsToAnswer', 'comparisonOptions', 'constraints', 'decisionDimensions', 'successCriteria'].every((k) =>
      Array.isArray(detail[k]) && (detail[k] as unknown[]).length <= 20 && (detail[k] as unknown[]).every((item) => typeof item === 'string')) &&
    Array.isArray(detail.contextRefs) && detail.contextRefs.length <= 10 && detail.contextRefs.every((item: unknown) =>
      !!item && typeof item === 'object' && ['url', 'favorite', 'research', 'summary'].includes(String((item as Record<string, unknown>).type)) &&
      typeof (item as Record<string, unknown>).value === 'string' && typeof (item as Record<string, unknown>).required === 'boolean') &&
    !!detail.scope && typeof detail.scope === 'object' && !Array.isArray(detail.scope) &&
    !!(detail.scope as Record<string, unknown>).timeRange && typeof (detail.scope as Record<string, unknown>).timeRange === 'object' &&
    ['any', '7d', '30d', '90d', '1y', 'custom'].includes(String(((detail.scope as Record<string, unknown>).timeRange as Record<string, unknown>).preset));
}

export function readResearchDraft(storage: DraftStorage, userId: string, conversationId: string): ResearchDraft | null {
  if (!userId || !conversationId) return null;
  try {
    const raw = storage.getItem(keyFor(userId, conversationId));
    if (!raw || raw.length > 100_000) return null;
    const data: unknown = JSON.parse(raw);
    return isDraft(data) ? data : null;
  } catch { return null; }
}
export function writeResearchDraft(storage: DraftStorage, userId: string, conversationId: string, draft: ResearchDraft): boolean {
  if (!userId || !conversationId || !isDraft(draft)) return false;
  try { storage.setItem(keyFor(userId, conversationId), JSON.stringify(draft)); return true; }
  catch { return false; }
}
