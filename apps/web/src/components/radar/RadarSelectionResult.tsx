'use client';

import MarkdownContent from '@/components/MarkdownContent';

export function RadarSelectionResult({ content }: { content: string }) {
  return <MarkdownContent content={content} compact className="text-sm leading-7" />;
}
