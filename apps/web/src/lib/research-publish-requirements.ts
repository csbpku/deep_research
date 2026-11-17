/** What a draft must contain before it can be published.
 *
 * Research reports need the three-part summary; knowledge cards and learning
 * paths carry their own structure, so requiring the same fields would make
 * authors duplicate content. Keep this in one place: the API and the editor
 * drifted apart once already.
 */
export type PublicationSummaryField = 'body' | 'background' | 'conclusion' | 'risks';

export interface PublicationSummaryInput {
  type?: string | null;
  creationMethod?: string | null;
  reportType?: string | null;
  body?: string | null;
  background?: string | null;
  conclusion?: string | null;
  risks?: string | null;
}

export interface PublicationSummaryRequirement {
  kind: 'knowledge' | 'learning_path' | 'comparison_matrix' | 'research';
  required: PublicationSummaryField[];
  missing: PublicationSummaryField[];
  missingLabels: string[];
  complete: boolean;
}

const LABELS: Record<PublicationSummaryField, string> = {
  body: '正文',
  background: '背景',
  conclusion: '结论',
  risks: '风险或待验证项',
};

export function publicationSummaryRequirement(input: PublicationSummaryInput): PublicationSummaryRequirement {
  const isAiReport = input.creationMethod === 'ai_research';
  const kind = input.type === 'knowledge'
    ? 'knowledge'
    : isAiReport && input.reportType === 'learning_path'
      ? 'learning_path'
      : isAiReport && input.reportType === 'comparison_matrix'
        ? 'comparison_matrix'
        : 'research';
  const required: PublicationSummaryField[] = kind === 'research'
    ? ['background', 'conclusion', 'risks']
    : ['body'];
  const missing = required.filter(field => !(input[field] ?? '').trim());
  return {
    kind,
    required,
    missing,
    missingLabels: missing.map(field => LABELS[field]),
    complete: missing.length === 0,
  };
}
