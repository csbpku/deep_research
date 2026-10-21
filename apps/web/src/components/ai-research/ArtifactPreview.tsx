'use client';

import React, { useEffect, useMemo, useState } from 'react';
import { ChevronLeft, ChevronRight, List, Maximize2, Presentation } from 'lucide-react';
import MarkdownContent from '@/components/MarkdownContent';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Chip from '@mui/material/Chip';
import IconButton from '@mui/material/IconButton';
import Paper from '@mui/material/Paper';
import Stack from '@mui/material/Stack';
import ToggleButton from '@mui/material/ToggleButton';
import ToggleButtonGroup from '@mui/material/ToggleButtonGroup';
import Typography from '@mui/material/Typography';

function splitSlides(content: string): string[] {
  const normalized = content.replace(/\r\n?/gu, '\n').trim();
  if (!normalized) return [];
  const slides = normalized.split(/\n(?=#{1,2}\s*(?:Slide|幻灯片)\b)/iu).map((slide) => slide.trim()).filter(Boolean);
  return slides.length > 1 ? slides : [normalized];
}

function slideTitle(content: string, index: number): string {
  const heading = content.match(/^#{1,3}\s+(.+)$/mu)?.[1]?.trim();
  if (!heading) return index === 0 ? '开场与研究问题' : `第 ${index + 1} 页`;
  return heading.replace(/^(?:Slide|幻灯片)\s*\d*\s*[:：-]?\s*/iu, '').trim() || `第 ${index + 1} 页`;
}

function slideBody(content: string): string {
  return content.replace(/^#{1,3}\s+.+$/mu, '').trim();
}

interface SlideStageContent {
  lead: string;
  bullets: string[];
  hiddenCount: number;
  truncated: boolean;
}

interface StageText {
  text: string;
  truncated: boolean;
}

/**
 * Keep the stage a speaking surface even when an older artifact contains a
 * report-sized paragraph. This is presentation-only: the outline view and
 * the screen-reader list still expose the original content in full.
 */
function compactStageText(value: string, limit: number): StageText {
  const normalized = value
    .replace(/!\[([^\]]*)\]\([^)]*\)/gu, '$1')
    .replace(/\[([^\]]+)\]\([^)]*\)/gu, '$1')
    .replace(/[\\*_`]/gu, '')
    .replace(/\s+/gu, ' ')
    .trim();
  if (normalized.length <= limit) return { text: normalized, truncated: false };

  // Prefer a complete sentence when the source gives us one early enough.
  const sentenceEnd = normalized.search(/[。！？.!?](?=\s|$)/u);
  if (sentenceEnd >= Math.min(48, limit - 20) && sentenceEnd < limit) {
    return { text: normalized.slice(0, sentenceEnd + 1), truncated: true };
  }
  return { text: `${normalized.slice(0, Math.max(1, limit - 1)).trimEnd()}…`, truncated: true };
}

/**
 * A 16:9 stage is a speaking surface, not a shrunken report reader. Keep the
 * first useful idea and a few points on stage while the outline mode and the
 * screen-reader list retain the complete slide content.
 */
function slideStageContent(content: string): SlideStageContent {
  const body = slideBody(content);
  const lines = body.split('\n').map((line) => line.trim()).filter(Boolean);
  const bullets = lines
    .filter((line) => /^\s*(?:[-*+]\s+|\d+[.)]\s+)/u.test(line))
    .map((line) => line.replace(/^\s*(?:[-*+]\s+|\d+[.)]\s+)/u, '').trim())
    .filter(Boolean);
  const paragraphs = lines.filter((line) => (
    !/^\s*(?:[-*+]\s+|\d+[.)]\s+)/u.test(line)
    && !/^#{1,6}\s+/u.test(line)
    && !/^\|/.test(line)
  ));
  const leadResult = paragraphs[0] ? compactStageText(paragraphs[0], 220) : { text: '', truncated: false };
  const visibleBullets = bullets.slice(0, 3).map((bullet) => compactStageText(bullet, 150));
  const lead = leadResult.text;
  const hiddenCount = Math.max(0, bullets.length - visibleBullets.length) + Math.max(0, paragraphs.length - (lead ? 1 : 0));
  return {
    lead,
    bullets: visibleBullets.map(({ text }) => text),
    hiddenCount,
    truncated: leadResult.truncated || visibleBullets.some(({ truncated }) => truncated),
  };
}

function slideStorageKey(content: string): string {
  // A small deterministic key keeps the user's place for this artifact
  // without storing the report itself or coupling it to a job id.
  let hash = 2166136261;
  for (let index = 0; index < content.length; index += 1) {
    hash ^= content.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return `ai-research-slides:v2:${hash >>> 0}`;
}

function slideKicker(content: string, index: number): string {
  if (index === 0) return 'THE QUESTION';
  const title = slideTitle(content, index);
  if (/风险|局限|挑战|代价|risk|limitation|trade.?off/iu.test(title)) return 'TRADE-OFF';
  if (/行动|下一步|建议|落地|action|recommendation|next/iu.test(title)) return 'NEXT MOVE';
  if (/比较|对比|取舍|compare|comparison/iu.test(title)) return 'COMPARISON';
  if (/证据|来源|核验|evidence|source/iu.test(title)) return 'SOURCE CHECK';
  return `FINDING ${String(index).padStart(2, '0')}`;
}

export function ArtifactPreview({ content }: { content: string }) {
  const slides = splitSlides(content);
  if (slides.length === 0) {
    return (
      <Paper component="section" variant="outlined" aria-label="Slides 提纲预览" sx={{ borderStyle: 'dashed', px: 2, py: 4, textAlign: 'center', color: 'text.secondary', typography: 'body2' }}>
        暂无可预览的演示提纲。
      </Paper>
    );
  }

  const [mode, setMode] = useState<'stage' | 'outline'>('stage');
  const [current, setCurrent] = useState(0);
  const storageKey = useMemo(() => slideStorageKey(content), [content]);
  const currentSlide = slides[current] ?? slides[0];
  const stageContent = slideStageContent(currentSlide);

  useEffect(() => {
    try {
      const saved = Number.parseInt(window.localStorage.getItem(storageKey) ?? '', 10);
      if (Number.isInteger(saved) && saved >= 0) {
        setCurrent(Math.min(slides.length - 1, saved));
      }
    } catch {
      // Private browsing or a restricted storage context should not affect
      // the presentation preview.
    }
  }, [slides.length, storageKey]);

  useEffect(() => {
    try {
      window.localStorage.setItem(storageKey, String(current));
    } catch {
      // The in-memory cursor remains fully usable when storage is unavailable.
    }
  }, [current, storageKey]);

  useEffect(() => {
    function handleKeyDown(event: KeyboardEvent) {
      if (mode !== 'stage') return;
      if (event.key === 'ArrowRight' || event.key === ' ') {
        event.preventDefault();
        setCurrent((value) => Math.min(slides.length - 1, value + 1));
      } else if (event.key === 'ArrowLeft') {
        event.preventDefault();
        setCurrent((value) => Math.max(0, value - 1));
      } else if (event.key === 'Home') {
        setCurrent(0);
      } else if (event.key === 'End') {
        setCurrent(slides.length - 1);
      }
    }
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [mode, slides.length]);

  return (
    <Stack component="section" spacing={2} aria-label="Slides 提纲预览">
      <Paper variant="outlined" sx={{ display: 'flex', flexWrap: 'wrap', alignItems: 'flex-start', justifyContent: 'space-between', gap: 2, borderColor: 'primary.main', bgcolor: 'action.selected', px: 2, py: 2 }}>
        <Box sx={{ minWidth: 0 }}>
          <Typography variant="fieldTitle" component="p" sx={{ display: 'flex', alignItems: 'center', gap: 1, color: 'text.primary' }}><Presentation size={16} color="currentColor" />Slides 提纲预览</Typography>
          <Typography variant="metadata" color="text.secondary" sx={{ mt: 0.5 }}>
            演示模式适合讲解或录屏；列表模式适合核对每页内容。它仍是按页组织的研究提纲，不是可下载的 .pptx 文件。
          </Typography>
        </Box>
        <Stack direction="row" spacing={1} sx={{ flexShrink: 0, alignItems: 'center' }}>
          <ToggleButtonGroup value={mode} exclusive size="small" aria-label="Slides 预览模式" onChange={(_event, value: 'stage' | 'outline' | null) => { if (value) setMode(value); }}>
            <ToggleButton value="stage"><Maximize2 size={14} />演示</ToggleButton>
            <ToggleButton value="outline"><List size={14} />列表</ToggleButton>
          </ToggleButtonGroup>
          <Chip size="small" variant="outlined" label={`${slides.length} 页`} />
        </Stack>
      </Paper>
      {mode === 'stage' ? (
        <Stack spacing={1.5}>
          <Paper
            component="div"
            role="button"
            tabIndex={0}
            aria-label={`演示第 ${current + 1} 页：${slideTitle(currentSlide, current)}`}
            aria-live="polite"
            onClick={(event) => {
              if ((event.target as HTMLElement).closest('a,button')) return;
              setCurrent((value) => Math.min(slides.length - 1, value + 1));
            }}
            onKeyDown={(event) => {
              if (event.key === 'Enter' || event.key === ' ') {
                event.preventDefault();
                setCurrent((value) => Math.min(slides.length - 1, value + 1));
              }
            }}
            data-slide-stage="true"
            sx={{ position: 'relative', display: 'block', aspectRatio: '16 / 9', width: '100%', overflow: 'hidden', border: 1, borderColor: 'divider', borderRadius: 'var(--dr-radius-large)', bgcolor: 'var(--dr-color-inverse-surface)', color: 'var(--dr-color-inverse-text)', textAlign: 'left', boxShadow: 'var(--dr-elevation-2)', cursor: 'pointer', '&:focus-visible': { outline: '2px solid var(--dr-color-primary)', outlineOffset: 2 } }}
          >
            <Box component="span" aria-hidden="true" sx={{ position: 'absolute', right: -48, top: -64, width: 208, height: 208, borderRadius: '50%', border: '1px solid color-mix(in srgb, var(--dr-color-tier-skim) 20%, transparent)', transition: 'transform var(--dr-motion-standard)', '&:hover': { transform: 'scale(1.04)' }, '@media (prefers-reduced-motion: reduce)': { transition: 'none' } }} />
            <Box component="span" aria-hidden="true" sx={{ position: 'absolute', bottom: '-24%', left: '38%', width: '1px', height: '120%', transform: 'rotate(28deg)', bgcolor: 'color-mix(in srgb, var(--dr-color-tier-skim) 15%, transparent)' }} />
            <Box sx={{ position: 'relative', zIndex: 1, display: 'grid', gridTemplateRows: 'auto minmax(0, 1fr) auto', height: '100%', p: { xs: 2.5, sm: 4.5, lg: 6 } }}>
              <Stack direction="row" spacing={1.5} sx={{ color: 'var(--dr-color-inverse-text)', opacity: 0.76, alignItems: 'center', justifyContent: 'space-between' }}>
                <Typography variant="metadata" sx={{ fontWeight: 500, letterSpacing: '0.08em', textTransform: 'uppercase' }}>Research / visual briefing</Typography>
                <Typography variant="metadata" sx={{ fontFamily: 'monospace', color: 'var(--dr-color-tier-skim)', fontVariantNumeric: 'tabular-nums' }}>{String(current + 1).padStart(2, '0')} / {String(slides.length).padStart(2, '0')}</Typography>
              </Stack>
              <Stack spacing={1.5} sx={{ minHeight: 0, maxWidth: 900, justifyContent: 'center', py: { xs: 2.5, sm: 4 } }}>
                <Typography variant="metadata" sx={{ fontFamily: 'monospace', letterSpacing: '0.1em', textTransform: 'uppercase', color: 'var(--dr-color-tier-skim)' }}>{slideKicker(currentSlide, current)}</Typography>
                <Typography component="h2" variant="h2" sx={{ mt: 1.5, maxWidth: 768, color: 'inherit', overflowWrap: 'anywhere' }}>{slideTitle(currentSlide, current)}</Typography>
                <Box data-slide-scroll sx={{ mt: 1, maxHeight: '42%', maxWidth: 800, overflowY: 'auto', pr: 1.5, typography: 'reading', color: 'var(--dr-color-inverse-text)', opacity: 0.82, fontSize: { xs: 'var(--dr-type-body)', sm: 'var(--dr-type-title-small)', lg: 'var(--dr-type-title-compact)' } }}>
                  {stageContent.lead ? <MarkdownContent content={stageContent.lead} compact className="[&_p]:my-0 [&_strong]:text-tier-skim" /> : null}
                  {stageContent.bullets.length > 0 ? (
                    <Stack component="ul" spacing={1.25} sx={{ mt: 1.5, mb: 0, pl: 0, listStyle: 'none' }}>
                      {stageContent.bullets.map((bullet, index) => (
                        <Stack component="li" key={`${index}-${bullet.slice(0, 32)}`} direction="row" spacing={1.25} sx={{ alignItems: 'baseline' }}>
                          <Box component="span" aria-hidden sx={{ width: 6, height: 6, mt: '0.65em', flexShrink: 0, borderRadius: '50%', bgcolor: 'var(--dr-color-tier-skim)' }} />
                          <Box sx={{ minWidth: 0 }}><MarkdownContent content={bullet} compact className="[&_p]:my-0 [&_strong]:text-tier-skim" /></Box>
                        </Stack>
                      ))}
                    </Stack>
                  ) : null}
                  {stageContent.hiddenCount > 0 || stageContent.truncated ? (
                    <Typography variant="metadata" sx={{ display: 'block', mt: 1.5, color: 'var(--dr-color-inverse-text)', opacity: 0.66 }}>
                      舞台显示短摘录；切换到“列表”查看完整提纲。
                    </Typography>
                  ) : null}
                  {!stageContent.lead && stageContent.bullets.length === 0 ? (
                    <MarkdownContent content={slideBody(currentSlide)} compact className="[&_h1]:hidden [&_h2]:hidden [&_h3]:hidden [&_p]:my-1 [&_ul]:my-2 [&_li]:my-1 [&_strong]:text-tier-skim" />
                  ) : null}
                </Box>
              </Stack>
              <Stack direction="row" spacing={1.5} sx={{ borderTop: '1px solid color-mix(in srgb, var(--dr-color-inverse-text) 16%, transparent)', pt: { xs: 1.5, sm: 2.5 }, color: 'var(--dr-color-inverse-text)', opacity: 0.72, alignItems: 'flex-end', justifyContent: 'space-between' }}>
                <Typography variant="metadata">点击舞台或使用 ← → / 空格推进 · 列表模式核对完整提纲</Typography>
                <Typography variant="metadata" sx={{ display: { xs: 'none', sm: 'block' }, whiteSpace: 'nowrap' }}>证据优先 · 结论可核验</Typography>
              </Stack>
            </Box>
          </Paper>
          <Box component="ol" aria-label="所有 Slides 内容" sx={{ position: 'absolute', width: 1, height: 1, p: 0, m: -1, overflow: 'hidden', clip: 'rect(0, 0, 0, 0)', whiteSpace: 'nowrap', border: 0 }}>
            {slides.map((slide, index) => <li key={`accessible-${index}`}>Slide {String(index + 1).padStart(2, '0')} · 第 {index + 1} 页：{slideTitle(slide, index)} · {slide}</li>)}
          </Box>
          <Stack direction="row" spacing={1.5} data-no-advance="true" sx={{ alignItems: 'center', justifyContent: 'space-between' }}>
            <Button type="button" variant="outlined" size="small" onClick={() => setCurrent((value) => Math.max(0, value - 1))} disabled={current === 0} startIcon={<ChevronLeft size={16} />}>上一页</Button>
            <Stack direction="row" spacing={0.25} aria-label="Slides 页码" sx={{ minWidth: 0, flex: 1, alignItems: 'center', justifyContent: 'center' }}>
              {slides.map((slide, index) => <IconButton key={`${index}-${slide.slice(0, 24)}`} type="button" aria-label={`跳到第 ${index + 1} 页`} aria-current={current === index ? 'page' : undefined} onClick={() => setCurrent(index)} sx={{ width: 24, height: 24 }}><Box component="span" sx={{ width: current === index ? 20 : 6, height: 6, borderRadius: 'var(--dr-radius-pill)', bgcolor: current === index ? 'primary.main' : 'divider', transition: 'width var(--dr-motion-fast)' }} /></IconButton>)}
            </Stack>
            <Button type="button" variant="outlined" size="small" onClick={() => setCurrent((value) => Math.min(slides.length - 1, value + 1))} disabled={current === slides.length - 1} endIcon={<ChevronRight size={16} />}>下一页</Button>
          </Stack>
        </Stack>
      ) : (
        <Box sx={{ display: 'grid', gap: 2, gridTemplateColumns: { xs: '1fr', md: 'repeat(2, minmax(0, 1fr))' } }}>
          {slides.map((slide, index) => (
            <Paper component="article" variant="outlined" key={`${index}-${slide.slice(0, 24)}`} aria-label={`第 ${index + 1} 页：${slideTitle(slide, index)}`} sx={{ minWidth: 0, p: { xs: 2.5, sm: 3 }, boxShadow: 'var(--dr-elevation-1)' }}>
              <Stack direction="row" spacing={1.5} sx={{ pb: 1.5, borderBottom: 1, borderColor: 'divider', alignItems: 'flex-start', justifyContent: 'space-between' }}>
                <Typography variant="metadata" color="text.secondary" sx={{ fontFamily: 'monospace', letterSpacing: '0.06em', textTransform: 'uppercase' }}>Slide {String(index + 1).padStart(2, '0')}</Typography>
                <Typography variant="metadata" title={slideTitle(slide, index)} sx={{ minWidth: 0, textAlign: 'right', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontWeight: 500 }}>{slideTitle(slide, index)}</Typography>
              </Stack>
              <Box sx={{ pt: 2 }}>
                <Typography variant="listTitle" component="h3">{slideTitle(slide, index)}</Typography>
                <Box sx={{ mt: 1.5, typography: 'body2' }}><MarkdownContent content={slideBody(slide)} compact /></Box>
              </Box>
            </Paper>
          ))}
        </Box>
      )}
    </Stack>
  );
}
