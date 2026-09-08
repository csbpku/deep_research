/**
 * Reader-facing projection of research execution and review state.
 *
 * The worker has to distinguish queues, leases, coverage and publication
 * gates. A reader does not. Keep those implementation states out of the
 * primary path and expose only the decision the reader needs to make.
 */

export type ResearchUserStatusCode =
  | 'researching'
  | 'ready'
  | 'needs_confirmation'
  | 'needs_revision'
  | 'sources_incomplete'
  | 'review_unavailable'
  | 'materials_only'
  | 'failed'
  | 'cancelled';

export interface ResearchUserStatusInput {
  status: string;
  reportType?: string | null;
  hasReport?: boolean;
  reviewStatus?: string | null;
  deliverableStatus?: 'report' | 'evidence_only' | 'none';
  capturedSourcesCount?: number;
  publishedResearchId?: string | null;
}

export interface ResearchUserStatus {
  code: ResearchUserStatusCode;
  label: string;
  description: string;
  tone: 'success' | 'warning' | 'danger' | 'neutral';
}

function hasNoInspectableSources(input: ResearchUserStatusInput): boolean {
  return input.capturedSourcesCount === 0;
}

/**
 * Convert execution/review state into a small, stable vocabulary for users.
 * This is deliberately a UI projection; persisted enums and API contracts do
 * not need to change when the copy or grouping changes.
 */
export function researchUserStatus(input: ResearchUserStatusInput): ResearchUserStatus {
  if (input.status === 'queued' || input.status === 'running') {
    return {
      code: 'researching',
      label: '正在研究',
      description: '正在收集和整理资料。完成后可以回来继续阅读。',
      tone: 'neutral',
    };
  }

  if (input.status === 'failed') {
    return {
      code: 'failed',
      label: '研究未完成',
      description: '这次研究没有完成；已保留的资料仍可查看。',
      tone: 'danger',
    };
  }

  if (input.status === 'cancelled') {
    return {
      code: 'cancelled',
      label: '已取消',
      description: '这次研究已取消。',
      tone: 'neutral',
    };
  }

  if (input.deliverableStatus === 'evidence_only' || input.status === 'partial' || input.deliverableStatus === 'none' || !input.hasReport) {
    return {
      code: 'materials_only',
      label: '资料已保留',
      description: '已保留可核对资料，但还没有形成完整研究结论。',
      tone: 'warning',
    };
  }

  // A quick brief is intentionally a lightweight orientation, not a review
  // gated research asset. Keep its existing promise without calling it
  // verified.
  if (input.reportType === 'summary_brief') {
    return hasNoInspectableSources(input)
      ? {
          code: 'materials_only',
          label: '仅模型摘录',
          description: '本轮没有可核对资料，只适合作为方向提示。',
          tone: 'warning',
        }
      : {
          code: 'ready',
          label: '快速判断已生成',
          description: '这是一个快速方向判断，不等同于完整研究结论。',
          tone: 'neutral',
        };
  }

  switch (input.reviewStatus) {
    case 'queued':
    case 'reviewing':
      return {
        code: 'researching',
        label: '结果整理中',
        description: '研究内容已经生成，依据还在整理；完成后会自动更新。',
        tone: 'neutral',
      };
    case 'blocked':
    case 'needs_revision':
      return {
        code: 'needs_revision',
        label: '需要修改',
        description: '来源之间存在不一致，修改相关内容后再继续使用。',
        tone: 'danger',
      };
    case 'coverage_insufficient':
    case 'research_insufficient':
      return {
        code: 'sources_incomplete',
        label: '资料范围有缺口',
        description: '当前资料还没有覆盖研究问题的全部关键部分。',
        tone: 'warning',
      };
    case 'review_unavailable':
    case 'unavailable':
      return {
        code: 'review_unavailable',
        label: '暂时无法确认',
        description: '当前还没有得到完整的依据确认；这不代表结论错误。',
        tone: 'warning',
      };
    case 'needs_action':
    case 'stale':
      return {
        code: 'needs_confirmation',
        label: '需要确认',
        description: '有些关键结论还缺少可以直接核对的依据。',
        tone: 'warning',
      };
    case 'passed':
      return {
        code: 'ready',
        label: '可以直接参考',
        description: '关键结论已有可核对依据；仍可打开来源查看原文。',
        tone: 'success',
      };
    case 'not_applicable':
      return {
        code: 'ready',
        label: '已完成',
        description: '产物已经生成，可以继续阅读或编辑。',
        tone: 'neutral',
      };
    default:
      return {
        code: 'needs_confirmation',
        label: '需要确认',
        description: '产物已经生成，但关键结论还没有完成确认。',
        tone: 'warning',
      };
  }
}
