'use client';

import { Download } from 'lucide-react';
import { AppButton } from '@/components/material/AppButton';
import { buildResearchMarkdown, researchMarkdownFilename, type ExportResearchMarkdownInput } from '@/lib/export-research-markdown';

export function ExportResearchMarkdownButton({ research }: { research: ExportResearchMarkdownInput }) {
  const download = () => {
    const blob = new Blob([buildResearchMarkdown(research)], { type: 'text/markdown;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = researchMarkdownFilename(research.title);
    anchor.click();
    URL.revokeObjectURL(url);
  };

  return (
    <AppButton
      type="button"
      variant="outlined"
      size="small"
      onClick={download}
      startIcon={<Download size={16} aria-hidden="true" />}
    >
      导出 Markdown
    </AppButton>
  );
}
