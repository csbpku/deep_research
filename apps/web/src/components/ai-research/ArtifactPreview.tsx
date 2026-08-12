'use client';

import React from 'react';
import MarkdownContent from '@/components/MarkdownContent';

function splitSlides(content: string): string[] {
  const normalized = content.replace(/\r\n?/gu, '\n').trim();
  if (!normalized) return [];
  const slides = normalized.split(/\n(?=#{1,2}\s*(?:Slide|幻灯片)\b)/iu).map((slide) => slide.trim()).filter(Boolean);
  return slides.length > 1 ? slides : [normalized];
}

export function ArtifactPreview({ content }: { content: string }) {
  const slides = splitSlides(content);
  return (
    <div className="grid gap-4 md:grid-cols-2" aria-label="Slides 页面预览">
      {slides.map((slide, index) => (
        <article key={`${index}-${slide.slice(0, 24)}`} className="aspect-[16/10] overflow-auto rounded-md border border-border bg-card p-5 shadow-sm">
          <p className="mb-3 font-mono text-[10px] uppercase tracking-[0.14em] text-muted-foreground">
            Slide {String(index + 1).padStart(2, '0')}
          </p>
          <MarkdownContent content={slide} compact className="text-sm" />
        </article>
      ))}
    </div>
  );
}
