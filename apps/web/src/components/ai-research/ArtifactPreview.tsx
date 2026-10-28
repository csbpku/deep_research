'use client';

import React, { useEffect, useMemo, useState } from 'react';
import { ChevronLeft, ChevronRight, List, Presentation } from 'lucide-react';
import MarkdownContent from '@/components/MarkdownContent';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Paper from '@mui/material/Paper';
import Stack from '@mui/material/Stack';
import ToggleButton from '@mui/material/ToggleButton';
import ToggleButtonGroup from '@mui/material/ToggleButtonGroup';
import Typography from '@mui/material/Typography';

function splitSlides(content: string): string[] {
  const normalized = content.replace(/\r\n?/gu, '\n').trim();
  if (!normalized) return [];
  const slides = normalized.split(/\n(?=#{1,2}\s*(?:Slide|幻灯片)\b)/iu).map(slide => slide.trim()).filter(Boolean);
  // A document title before an explicitly numbered first slide is metadata.
  // Older decks with an unnumbered cover followed by Slide 2 retain the cover.
  if (slides.length > 1 && /^#{1,2}\s*(?:Slide|幻灯片)\s*1\s*[:：]/iu.test(slides[1]) && /^#[^\n]+$/u.test(slides[0])) slides.shift();
  return slides;
}
function slideTitle(content: string, index: number): string {
  return content.match(/^#{1,3}\s+(.+)$/mu)?.[1]?.trim().replace(/^(?:Slide|幻灯片)\s*\d*\s*[:：-]?\s*/iu, '').trim() || `第 ${index + 1} 页`;
}
function slideBody(content: string): string { return content.replace(/^#{1,3}\s+.+$/mu, '').trim(); }
interface SlideSource { url: string; title: string }
interface StageText { text: string; truncated: boolean }
function compactText(value: string, limit: number, sources: SlideSource[]): StageText {
  const normalized = value.replace(/!\[([^\]]*)\]\([^)]*\)/gu, '$1')
    .replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/gu, (_match, title: string, url: string) => {
      try { new URL(url); } catch { return title; }
      let index = sources.findIndex(source => source.url === url);
      if (index < 0) { sources.push({ title, url }); index = sources.length - 1; }
      return ` [${index + 1}]`;
    }).replace(/[\\*]/gu, '').replace(/\s+/gu, ' ').trim();
  if (normalized.length <= limit) return { text: normalized, truncated: false };
  return { text: `${normalized.slice(0, limit - 1).trimEnd()}…`, truncated: true };
}
function stageContent(content: string) {
  const sources: SlideSource[] = [];
  const lines = slideBody(content).split('\n').map(line => line.trim()).filter(Boolean);
  const bullets = lines.filter(line => /^(?:[-*+]\s+|\d+[.)]\s+)/u.test(line)).map(line => line.replace(/^(?:[-*+]\s+|\d+[.)]\s+)/u, ''));
  const paragraphs = lines.filter(line => !/^(?:[-*+]\s+|\d+[.)]\s+|#{1,6}\s+|\|)/u.test(line));
  const lead = compactText(paragraphs[0] ?? '', 180, sources);
  const points = bullets.slice(0, 3).map(bullet => compactText(bullet, 170, sources));
  return { lead: lead.text, bullets: points.map(point => point.text), sources,
    condensed: lead.truncated || points.some(point => point.truncated) || bullets.length > 3 || paragraphs.length > 1 };
}
function StageLine({ text, sources }: { text: string; sources: SlideSource[] }) {
  return <>{text.split(/(`[^`]+`|\[\d+\])/gu).map((part, index) => {
    if (part.startsWith('`')) return <Box component="code" key={index} sx={{ fontFamily: 'inherit', fontWeight: 600, color: 'info.main', overflowWrap: 'anywhere' }}>{part.slice(1, -1)}</Box>;
    const number = /^\[(\d+)\]$/u.exec(part)?.[1];
    const source = number ? sources[Number(number) - 1] : undefined;
    if (source) return <Box component="a" key={index} href={source.url} target="_blank" rel="noreferrer noopener" aria-label={`来源 ${number}：${source.title}`} title={source.title} sx={{ color: 'info.main', fontSize: '0.65em', fontWeight: 600, verticalAlign: 'super', textDecoration: 'none', ml: 0.25, '&:hover': { textDecoration: 'underline' }, '&:focus-visible': { outline: '2px solid', outlineOffset: 3 } }}>{part}</Box>;
    return part;
  })}</>;
}
function storageKey(content: string): string {
  let hash = 2166136261;
  for (let i = 0; i < content.length; i++) { hash ^= content.charCodeAt(i); hash = Math.imul(hash, 16777619); }
  return `ai-research-slides:v2:${hash >>> 0}`;
}

export function ArtifactPreview({ content }: { content: string }) {
  const slides = useMemo(() => splitSlides(content), [content]);
  const [mode, setMode] = useState<'stage' | 'outline'>('stage');
  const [current, setCurrent] = useState(0);
  const key = useMemo(() => storageKey(content), [content]);
  useEffect(() => {
    try {
      const saved = Number.parseInt(window.localStorage.getItem(key) ?? '', 10);
      setCurrent(Number.isInteger(saved) && saved >= 0 ? Math.min(Math.max(0, slides.length - 1), saved) : 0);
    } catch { setCurrent(0); }
  }, [slides.length, key]);
  useEffect(() => { try { window.localStorage.setItem(key, String(current)); } catch { /* Preview works without storage. */ } }, [current, key]);
  if (!slides.length) return <Paper component="section" variant="outlined" aria-label="Slides 提纲预览" sx={{ p: 4, color: 'text.secondary', textAlign: 'center' }}>暂无可预览的演示提纲。</Paper>;
  const index = Math.min(current, slides.length - 1);
  const slide = slides[index];
  const stage = stageContent(slide);
  function advance(delta: number) { setCurrent(value => Math.max(0, Math.min(slides.length - 1, value + delta))); }
  return (
    <Stack component="section" spacing={2} aria-label="Slides 提纲预览" sx={{ minWidth: 0, width: '100%', containerType: 'inline-size', position: 'relative' }}>
      <Box sx={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', justifyContent: 'space-between', gap: 1.5, minWidth: 0 }}>
        <Box>
          <Typography component="h3" variant="fieldTitle" sx={{ display: 'flex', alignItems: 'center', gap: 1 }}><Presentation size={17} aria-hidden />Slides 提纲</Typography>
          <Typography variant="metadata" color="text.secondary" sx={{ mt: 0.5 }}>演示看要点，列表核对全文；不是可下载的 .pptx 文件。</Typography>
        </Box>
        <ToggleButtonGroup value={mode} exclusive size="small" sx={{ '& .MuiToggleButton-root': { color: 'text.primary' } }} aria-label="Slides 预览模式" onChange={(_event, value: 'stage' | 'outline' | null) => { if (value) setMode(value); }}>
          <ToggleButton value="stage"><Presentation size={14} aria-hidden />演示</ToggleButton>
          <ToggleButton value="outline"><List size={14} aria-hidden />列表</ToggleButton>
        </ToggleButtonGroup>
      </Box>
      {mode === 'stage' ? <>
        <Paper component="div" role="group" tabIndex={0} aria-label={`演示第 ${index + 1} 页：${slideTitle(slide, index)}`} data-slide-stage="true"
          onKeyDown={event => {
            if (event.target !== event.currentTarget) return;
            if (['ArrowRight', ' ', 'Enter'].includes(event.key)) { event.preventDefault(); advance(1); }
            else if (event.key === 'ArrowLeft') { event.preventDefault(); advance(-1); }
            else if (event.key === 'Home') { event.preventDefault(); setCurrent(0); }
            else if (event.key === 'End') { event.preventDefault(); setCurrent(slides.length - 1); }
          }}
          variant="outlined" sx={{ display: 'flex', flexDirection: 'column', justifyContent: 'space-between', gap: { xs: 3, sm: 4 }, minWidth: 0, width: '100%', boxSizing: 'border-box', flexShrink: 0, minHeight: { xs: 380, sm: 'max(440px, 56.25cqw)' }, p: { xs: 3, sm: 4, lg: 5 }, borderRadius: 2, bgcolor: 'background.paper', color: 'text.primary', '&:focus-visible': { outline: '2px solid var(--dr-color-primary)', outlineOffset: 3 } }}>
          <Box sx={{ minWidth: 0, flex: 1, display: 'flex', flexDirection: 'column', justifyContent: index === 0 && !stage.bullets.length ? 'center' : 'flex-start', gap: { xs: 3, sm: 3.5 } }}>
            <Typography component="h2" sx={{ fontSize: { xs: 28, sm: 36, lg: 44 }, lineHeight: 1.22, fontWeight: 700, letterSpacing: '-0.025em', color: 'text.primary', maxWidth: '24ch', overflowWrap: 'anywhere', textWrap: 'balance' }}>{slideTitle(slide, index)}</Typography>
            {stage.lead ? <Typography component="p" sx={{ m: 0, color: 'text.secondary', fontSize: { xs: 17, sm: 20, lg: 22 }, lineHeight: 1.65, maxWidth: '56ch', overflowWrap: 'anywhere' }}><StageLine text={stage.lead} sources={stage.sources} /></Typography> : null}
            {stage.bullets.length ? <Box component="ul" sx={{ display: 'grid', gap: 0, listStyle: 'none', p: 0, m: 0, minWidth: 0 }}>
              {stage.bullets.map((bullet, point) => <Box component="li" key={point} sx={{ color: 'text.primary', fontSize: { xs: 18, sm: 21, lg: 24 }, lineHeight: 1.6, overflowWrap: 'anywhere', py: { xs: 1.5, sm: 2 }, borderTop: point ? 1 : 0, borderColor: 'divider', '&:first-of-type': { pt: 0 }, '&:last-of-type': { pb: 0 } }}><StageLine text={bullet} sources={stage.sources} /></Box>)}
            </Box> : null}
            {stage.condensed ? <Typography variant="metadata" color="text.secondary">本页为演示摘录，完整内容保留在列表中。</Typography> : null}
          </Box>
          <Box sx={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', justifyContent: 'space-between', gap: 1.5, borderTop: 1, borderColor: 'divider', pt: 2, minWidth: 0 }}>
            <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 1.5, minWidth: 0 }}>
              {stage.sources.map((source, sourceIndex) => <Box key={source.url} component="a" href={source.url} target="_blank" rel="noreferrer noopener" title={source.title} sx={{ typography: 'metadata', color: 'info.main', textDecoration: 'none', '&:hover': { textDecoration: 'underline' }, overflowWrap: 'anywhere' }}>[{sourceIndex + 1}] {new URL(source.url).hostname}</Box>)}
            </Box>
            <Typography component="span" variant="metadata" color="text.secondary" sx={{ ml: 'auto', whiteSpace: 'nowrap', fontVariantNumeric: 'tabular-nums' }} aria-live="polite">{index + 1} / {slides.length} 页</Typography>
          </Box>
        </Paper>
        <Box component="ol" aria-label="所有 Slides 内容" sx={{ position: 'absolute', left: 0, top: 0, width: '1px', height: '1px', p: 0, m: 0, overflow: 'hidden', clip: 'rect(0, 0, 0, 0)', whiteSpace: 'nowrap', border: 0 }}>
          {slides.map((item, i) => <li key={i}>Slide {String(i + 1).padStart(2, '0')} · 第 {i + 1} 页：{slideTitle(item, i)} · {item}</li>)}
        </Box>
        <Box sx={{ display: 'grid', gridTemplateColumns: 'auto minmax(0, 1fr) auto', alignItems: 'center', gap: 1, minWidth: 0 }}>
          <Button variant="outlined" size="small" aria-label="上一页" disabled={index === 0} onClick={() => advance(-1)} sx={{ minWidth: 40 }}><ChevronLeft size={16} /><Box component="span" sx={{ display: { xs: 'none', sm: 'inline' }, ml: 0.5 }}>上一页</Box></Button>
          <Box aria-label="Slides 页码" sx={{ display: 'flex', minWidth: 0, overflowX: 'auto', justifyContent: { xs: 'flex-start', sm: 'center' }, gap: 0.5, p: 0.5 }}>
            {slides.map((_item, i) => <Button key={i} size="small" aria-label={`跳到第 ${i + 1} 页`} aria-current={index === i ? 'page' : undefined} variant={index === i ? 'contained' : 'text'} onClick={() => setCurrent(i)} sx={{ minWidth: 32, width: 32, height: 32, flexShrink: 0, p: 0 }}>{i + 1}</Button>)}
          </Box>
          <Button variant="outlined" size="small" aria-label="下一页" disabled={index === slides.length - 1} onClick={() => advance(1)} sx={{ minWidth: 40 }}><Box component="span" sx={{ display: { xs: 'none', sm: 'inline' }, mr: 0.5 }}>下一页</Box><ChevronRight size={16} /></Button>
        </Box>
      </> : <Box sx={{ display: 'grid', gap: 3, minWidth: 0 }}>
        {slides.map((item, i) => <Box component="article" key={i} aria-label={`第 ${i + 1} 页：${slideTitle(item, i)}`} sx={{ borderBottom: 1, borderColor: 'divider', pb: 3, minWidth: 0 }}>
          <Typography variant="metadata" color="text.secondary">第 {i + 1} / {slides.length} 页</Typography>
          <Typography component="h3" sx={{ mt: 1, mb: 2, fontSize: 22, fontWeight: 600 }}>{slideTitle(item, i)}</Typography>
          <MarkdownContent content={slideBody(item)} compact />
        </Box>)}
      </Box>}
      <Typography variant="metadata" color="text.secondary">{slides.length} 页 · 聚焦演示页面后，可用 ← →、空格和 Home / End 翻页。</Typography>
    </Stack>
  );
}
