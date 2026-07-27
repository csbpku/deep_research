import { createHash } from 'node:crypto';

export interface ResearchContentForHash {
  title: string;
  body: string;
  background: string | null;
  conclusion: string | null;
  risks: string | null;
  tags: string[];
}

function normalizeText(value: string | null): string {
  return (value ?? '')
    .replace(/\r\n?/gu, '\n')
    .split('\n')
    .map((line) => line.trimEnd())
    .join('\n')
    .trim();
}

/** Stable hash used by the AI worker and publish gate for human-edit detection. */
export function normalizedSha256(content: ResearchContentForHash): string {
  const normalized = {
    title: normalizeText(content.title),
    body: normalizeText(content.body),
    background: normalizeText(content.background),
    conclusion: normalizeText(content.conclusion),
    risks: normalizeText(content.risks),
    tags: [...new Set((content.tags ?? []).map((tag) => tag.trim()).filter(Boolean))].sort(),
  };
  return createHash('sha256').update(JSON.stringify(normalized), 'utf8').digest('hex');
}

/** Compatibility with AI drafts created before normalized hashing was introduced. */
export function legacyBodySha256(body: string): string {
  return createHash('sha256').update(body, 'utf8').digest('hex');
}
