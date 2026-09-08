import { createHash } from 'node:crypto';

/**
 * The unit reviewed and published is the complete research snapshot, not
 * only the Markdown body.  Summary fields are user-editable and may contain
 * factual claims too, so changing any of them must invalidate the review.
 */
export interface ResearchRevisionFields {
  title?: string | null;
  body?: string | null;
  background?: string | null;
  conclusion?: string | null;
  risks?: string | null;
  tags?: readonly string[] | null;
}

export function hashResearchRevision(fields: ResearchRevisionFields): string {
  const snapshot = {
    title: fields.title ?? '',
    body: fields.body ?? '',
    background: fields.background ?? null,
    conclusion: fields.conclusion ?? null,
    risks: fields.risks ?? null,
    tags: fields.tags ? [...fields.tags] : [],
  };
  return createHash('sha256').update(JSON.stringify(snapshot), 'utf8').digest('hex');
}
