// 记录判断的草稿持久化。
//
// "留下判断"是这个产品的核心动作，但对话框是一次性容器：按 Esc 关掉就
// 丢掉用户已经写好的内容。这里按 radarSummaryId 把未提交的笔记存到
// localStorage，重新打开时恢复，并让用户能显式丢弃。
//
// 只持久化用户自己输入的文字；摘录/AI 摘要每次打开时重新取，不入库。

const STORAGE_PREFIX = 'dr:radar-judgment-draft:';

export interface RadarJudgmentDraft {
  note: string;
  updatedAt: number;
}

function storageKey(radarSummaryId: string): string {
  return `${STORAGE_PREFIX}${radarSummaryId}`;
}

/** localStorage 在隐私模式/受限环境下可能抛错；草稿功能不能因此崩掉。 */
function safeStorage(): Storage | null {
  try {
    if (typeof window === 'undefined' || !window.localStorage) return null;
    return window.localStorage;
  } catch {
    return null;
  }
}

export function readJudgmentDraft(radarSummaryId: string): RadarJudgmentDraft | null {
  const storage = safeStorage();
  if (!storage || !radarSummaryId) return null;
  try {
    const raw = storage.getItem(storageKey(radarSummaryId));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<RadarJudgmentDraft>;
    if (typeof parsed.note !== 'string' || !parsed.note.trim()) return null;
    return {
      note: parsed.note,
      updatedAt: typeof parsed.updatedAt === 'number' ? parsed.updatedAt : 0,
    };
  } catch {
    return null;
  }
}

export function writeJudgmentDraft(radarSummaryId: string, note: string): void {
  const storage = safeStorage();
  if (!storage || !radarSummaryId) return;
  try {
    if (!note.trim()) {
      storage.removeItem(storageKey(radarSummaryId));
      return;
    }
    storage.setItem(storageKey(radarSummaryId), JSON.stringify({
      note,
      updatedAt: Date.now(),
    } satisfies RadarJudgmentDraft));
  } catch {
    // 存储不可用时退化为"关闭即丢弃"，不阻塞保存流程。
  }
}

export function clearJudgmentDraft(radarSummaryId: string): void {
  const storage = safeStorage();
  if (!storage || !radarSummaryId) return;
  try {
    storage.removeItem(storageKey(radarSummaryId));
  } catch {
    // 同上：清理失败不影响主流程。
  }
}
