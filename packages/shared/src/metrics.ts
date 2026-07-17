export const PRODUCT_EVENT_NAME = {
  DETAIL_READ_COMPLETED: 'detail_read_completed',
  COMMENT_CREATED: 'comment_created',
  SHARE_SUBMITTED: 'share_submitted',
  AI_RESEARCH_SUBMITTED: 'ai_research_submitted',
  RESEARCH_PUBLISHED: 'research_published',
  TIME_SAVED_REPORTED: 'time_saved_reported',
} as const;

export type ProductEventName =
  (typeof PRODUCT_EVENT_NAME)[keyof typeof PRODUCT_EVENT_NAME];

export const ADMIN_ACTION_TYPE = {
  APPROVE_SHARE: 'approve_share',
  REJECT_SHARE: 'reject_share',
  APPROVE_NOMINATION: 'approve_nomination',
  REJECT_NOMINATION: 'reject_nomination',
  SET_ROLE: 'set_role',
  DISABLE_USER: 'disable_user',
  RESTORE_USER: 'restore_user',
  BUDGET_OVERRIDE: 'budget_override',
} as const;

export type AdminActionType =
  (typeof ADMIN_ACTION_TYPE)[keyof typeof ADMIN_ACTION_TYPE];
