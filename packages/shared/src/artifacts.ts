/** Cross-runtime contract for research outputs. */

export const ARTIFACT_TYPES = {
  MARKDOWN: 'markdown',
  SLIDES: 'slides',
  TABLE: 'table',
  CHART: 'chart',
} as const;

export type ArtifactType = typeof ARTIFACT_TYPES[keyof typeof ARTIFACT_TYPES];

export interface ArtifactSourceRef {
  type: 'url' | 'summary' | 'research' | 'favorite';
  value: string;
  title?: string | null;
}

export interface ResearchArtifact {
  type: ArtifactType;
  title: string;
  version: number;
  mimeType: 'text/markdown' | 'application/json';
  content: string | null;
  /** Optional unrendered source retained for safe, lossless revisions. */
  rawContent?: string | null;
  payload: unknown | null;
  sourceRefs: ArtifactSourceRef[];
  sourceHash: string | null;
  draftResearchId: string | null;
}
