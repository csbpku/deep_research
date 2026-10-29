// sessionStorage 工具:跨页面共享"刚提交的调研"状态。
// 详情页跳回时,父页和首页都能显示一条"查看进度"提醒横幅。
//
// 写入:父页 /ai-research 提交成功后
// 读取 + 渲染:首页 / 父页顶部
// TTL:120s(过期自动失效)

export const LAST_SUBMITTED_KEY = 'ai-research:last-submitted:v1';
export const LAST_SUBMITTED_TTL_MS = 120_000;

export interface LastSubmitted {
  jobId: string;
  topic: string;
  at: number;
}

export function writeLastSubmitted(jobId: string, topic: string): void {
  if (typeof window === 'undefined') return;
  try {
    window.sessionStorage.setItem(
      LAST_SUBMITTED_KEY,
      JSON.stringify({ jobId, topic, at: Date.now() }),
    );
  } catch {
    // sessionStorage 在隐身/受限模式下不可用 —— 不抛错,横幅不显示。
  }
}
