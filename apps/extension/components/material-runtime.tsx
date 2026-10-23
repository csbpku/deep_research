import { safeSourceUrl } from '../web-search.js';
import { space } from "@deep-research/design-system";
import React, { useLayoutEffect, useRef, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { flushSync } from 'react-dom';
import { ThemeProvider } from '@mui/material/styles';
import Box from '@mui/material/Box';
import Paper from '@mui/material/Paper';
import Typography from '@mui/material/Typography';
import Chip from '@mui/material/Chip';
import ListItemButton from '@mui/material/ListItemButton';
import Menu from '@mui/material/Menu';
import MenuItem from '@mui/material/MenuItem';
import Stack from '@mui/material/Stack';
import Divider from '@mui/material/Divider';
import { ReaderButton } from './reader-controls';
import { ComposerIcon } from './reader-header';
import { readerTheme } from './reader-theme';
import { renderMarkdown } from '../markdown-renderer.js';
import { readingAnswerText } from '../reader-core.js';
import { t } from '../i18n.js';

const roots = new WeakMap<Element, Root>();
function render(host: Element, content: React.ReactNode) {
  let root = roots.get(host);
  if (!root) { root = createRoot(host); roots.set(host, root); }
  // Each region is its own React root, and React context does not cross root
  // boundaries, so the theme has to be provided again here. The Reader theme
  // carries no colour schemes, so this provider never writes a `light`/`dark`
  // class onto <html>: the two providers cannot disagree about a palette.
  flushSync(() => root.render(<ThemeProvider theme={readerTheme}>{content}</ThemeProvider>));
}
export function MaterialMarkdown({ text, className, bind }: { text: string; className?: string; bind?: (element: HTMLElement) => void }) {
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => { if (ref.current) { renderMarkdown(ref.current, readingAnswerText(text)); bind?.(ref.current); } }, [text, bind]);
  return <Box ref={ref} className={className} sx={{ fontSize: 'var(--reader-type-reading)', lineHeight: 'var(--reader-line-height-reading)', overflowWrap: 'anywhere' }} />;
}
interface Message { role: string; content: string; webSources?: { title: string; url: string }[]; searchStatus?: string }
function CopyAction({ text, onError }: { text: string; onError?: () => void }) {
  const [copied, setCopied] = useState(false);
  return <ReaderButton className="conversation-copy" variant="outlined" startIcon={<ComposerIcon kind="copy" />} aria-label={t('复制这条回答')} onClick={async () => {
    try { await navigator.clipboard.writeText(readingAnswerText(text)); setCopied(true); } catch { onError?.(); }
  }}>{copied ? t('已复制') : t('复制')}</ReaderButton>;
}
export function renderMaterialConversation(host: Element, messages: Message[], options: { copy?: boolean; bindLatest?: (element: HTMLElement) => void; onCopyError?: () => void } = {}) {
  const latest = messages.map(m => m.role).lastIndexOf('assistant');
  render(host, messages.map((message, index) => <Box component="article" key={index} className={`conversation-message history-detail-message ${message.role}`} sx={message.role === 'user' ? { justifySelf: 'end', width: 'fit-content', maxWidth: '92%', p: space.md, borderRadius: '12px 12px 4px 12px', bgcolor: 'action.hover' } : { minWidth: 0 }}>
    {message.role === 'assistant' && <Typography component="div" className="conversation-message-header history-detail-message-header" variant="caption" color="text.secondary" sx={{ mb: space.sm }}>Reader</Typography>}
    {message.role === 'assistant' ? <MaterialMarkdown className="conversation-message-body history-detail-message-body" text={message.content} bind={index === latest ? options.bindLatest : undefined} /> : <Typography component="div" className="conversation-message-body history-detail-message-body" variant="body1">{message.content}</Typography>}
    {message.role === 'assistant' && Boolean(message.webSources?.length) && <Box className="answer-web-sources" sx={{ mt: space.md, pt: space.md, borderTop: 1, borderColor: 'divider' }}>
      <Typography variant="caption" component="div" color="text.secondary">{t('网络来源 · 搜索摘要')}</Typography>
      <Box component="ol" sx={{ listStyle: 'none', m: 0, p: 0 }}>
        {message.webSources?.filter(source => safeSourceUrl(source.url)).slice(0, 4).map((source, i) => <Box component="li" key={source.url} sx={{ mt: space.sm, overflowWrap: 'anywhere' }}>
          <Typography component="a" href={safeSourceUrl(source.url)} target="_blank" rel="noopener noreferrer" variant="body2" color="primary.main">[W{i + 1}] {source.title || new URL(source.url).hostname}</Typography>
        </Box>)}
      </Box>
    </Box>}
    {message.role === 'assistant' && message.searchStatus === 'unavailable' && <Typography component="div" variant="caption" color="text.secondary" sx={{ mt: space.sm }}>{t('联网搜索暂不可用，本次依据原文回答，未核实最新网络信息。')}</Typography>}
    {options.copy && message.role === 'assistant' && index !== latest && <Box className="conversation-message-tools" sx={{ mt: space.md }}><CopyAction text={[message.content, ...(message.webSources || []).map((source, i) => `[W${i + 1}] ${source.title} ${safeSourceUrl(source.url)}`)].join('\n')} onError={options.onCopyError} /></Box>}
  </Box>));
}
export interface MaterialEvidence { id?: string; claim?: string; quote?: string; url?: string; anchored?: boolean; onLocate?: () => void }
export function renderMaterialEvidence(host: Element, items: MaterialEvidence[]) {
  render(host, items.map((item, index) => <ListItemButton component="a" href={item.url || '#'} target="_blank" rel="noreferrer noopener" key={index} id={item.id} className="evidence-item history-detail-evidence-item" data-evidence-index={index} title={item.anchored ? t('在网页中定位') : t('打开原文')} onClick={event => { if (item.onLocate) { event.preventDefault(); item.onLocate(); } }} sx={{ alignItems: 'flex-start', gap: space.sm, border: 1, borderColor: 'divider', borderRadius: '8px', p: space.md, mb: space.sm, textDecoration: 'none' }}>
    <Typography component="span" className="evidence-number" variant="caption" color="primary">[{index + 1}]</Typography>
    <Box component="span" className="evidence-content" sx={{ minWidth: 0 }}>
      {item.claim && <Typography component="span" className="evidence-claim" variant="body2" sx={{ display: 'block', fontWeight: 600 }}>{item.claim}</Typography>}
      <Typography component="span" className="evidence-quote" variant="caption" color="text.secondary" sx={{ display: '-webkit-box', WebkitBoxOrient: 'vertical', WebkitLineClamp: 2, overflow: 'hidden', mt: space.xs }}>“{item.quote}”</Typography>
      <Typography component="span" className="evidence-open" variant="caption" color="primary" sx={{ display: 'block', mt: space.sm }}>{item.anchored ? t('在网页中定位') : t('打开原文')}</Typography>
    </Box>
  </ListItemButton>));
}
export interface MaterialAction { label: string; run: () => void; danger?: boolean; action?: string }
export interface MaterialRecord { key: string; className?: string; title: string; source?: string; detail?: string; answer?: string; meta?: string; status?: string; warning?: boolean; tags?: string[]; actions: MaterialAction[]; visibleActions?: number }
function RecordActions({ actions, visible = actions.length }: { actions: MaterialAction[]; visible?: number }) {
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);
  return <Stack className="history-card-actions actions" direction="row" useFlexGap sx={{ mt: space.md, flexWrap: 'wrap', gap: space.sm }}>
    {actions.slice(0, visible).map((action, i) => <ReaderButton key={i} className="history-card-action" color={action.danger ? 'error' : 'primary'} variant={i === 0 ? 'outlined' : 'text'} data-action={action.action} onClick={action.run}>{action.label}</ReaderButton>)}
    {actions.length > visible && <><ReaderButton aria-label={t('更多记录操作')} aria-haspopup="menu" aria-expanded={Boolean(anchor)} onClick={event => setAnchor(event.currentTarget)} sx={{ ml: 'auto' }}>{t('更多⌄')}</ReaderButton><Menu anchorEl={anchor} open={Boolean(anchor)} onClose={() => setAnchor(null)}>{actions.slice(visible).map((action, i) => <MenuItem key={i} onClick={() => { setAnchor(null); action.run(); }} sx={action.danger ? { color: 'error.main' } : undefined}>{action.label}</MenuItem>)}</Menu></>}
  </Stack>;
}
export function renderMaterialRecords(host: Element, records: MaterialRecord[], empty?: string) {
  render(host, records.length ? records.map(record => <Paper component="article" variant="outlined" className={record.className || 'history-card'} key={record.key} sx={{ minWidth: 0, p: space.lg, mb: space.md, overflowWrap: 'anywhere' }}>
    <Stack direction="row" sx={{ justifyContent: 'space-between', alignItems: 'flex-start', gap: space.sm }}><Typography component="h3" className="history-card-title row-title" variant="subtitle1" sx={{ minWidth: 0 }}>{record.title}</Typography>{record.status && <Chip size="small" className="history-status" color={record.warning ? 'warning' : 'default'} variant="outlined" label={record.status} sx={{ flexShrink: 0 }} />}</Stack>
    {record.source && <Typography component="div" className="history-card-source" variant="caption" color="text.secondary" noWrap sx={{ mt: space.xs }}>{record.source}</Typography>}
    {record.detail && <Typography component="div" className="history-question history-insight-quote" variant="body2" sx={{ mt: space.md, whiteSpace: 'pre-wrap' }}>{record.detail}</Typography>}
    {record.answer && <Box sx={{ mt: space.md }}><MaterialMarkdown text={record.answer} className="history-insight-answer" /></Box>}
    {record.tags?.length ? <Stack direction="row" useFlexGap sx={{ mt: space.md, flexWrap: 'wrap', gap: space.sm }}>{record.tags.map(tag => <Chip size="small" key={tag} label={tag} />)}</Stack> : null}
    {record.meta && <Typography component="div" className="history-card-meta row-meta" variant="caption" color="text.secondary" sx={{ mt: space.md }}>{record.meta}</Typography>}
    <RecordActions actions={record.actions} visible={record.visibleActions} />
  </Paper>) : <Typography className="history-empty" color="text.secondary" variant="body2" sx={{ py: space.section }}>{empty}</Typography>);
}
export function renderMaterialFollowups(host: Element, prompts: string[], run: (prompt: string) => void) {
  render(host, <Stack divider={<Divider />} spacing={space.xs}>{prompts.map(prompt => <ReaderButton key={prompt} className="discussion-followup" control="followup" variant="text" fullWidth endIcon={<ComposerIcon kind="arrow-forward" size={18} />} onClick={() => run(prompt)}><span>{prompt}</span></ReaderButton>)}</Stack>);
}
export function renderMaterialOptions(host: Element, options: { id: string; label: string }[], selected: string, run: (id: string) => void) {
  render(host, options.map(item => <ListItemButton component="button" type="button" key={item.id} className="composer-model-option" role="option" data-model-id={item.id} aria-selected={selected === item.id} selected={selected === item.id} onClick={() => run(item.id)} sx={{ width: '100%', borderRadius: '8px', overflowWrap: 'anywhere' }}>{item.label}</ListItemButton>));
}
export function renderMaterialFailures(host: Element, items: { id: string; kind: string; label?: string; error?: string }[], retrying: string | null, retry: (item: object) => void, mark: (id: string) => void) {
  render(host, items.slice(0, 20).map(item => <Paper variant="outlined" key={item.id} className="translation-failure-row" sx={{ p: space.md, mt: space.sm }}><Typography className="translation-failure-label" variant="body2">{item.kind === 'image' ? t('图片') : t('正文')} · {item.label || item.id}</Typography><Typography className="translation-failure-error" variant="caption" color="text.secondary" sx={{ overflowWrap: 'anywhere' }}>{item.error || t('处理失败')}</Typography><Stack direction="row" sx={{ mt: space.sm, gap: space.sm }}>{item.kind === 'image' && /动画图片只处理/u.test(item.error || '') && <ReaderButton disabled={Boolean(retrying)} onClick={() => mark(item.id)}>{t('标记当前帧')}</ReaderButton>}<ReaderButton className="translation-retry" variant="outlined" disabled={Boolean(retrying)} onClick={() => retry(item)}>{retrying === item.id ? t('处理中…') : t('重试')}</ReaderButton></Stack></Paper>));
}
