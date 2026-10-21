'use client';

import React, { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { Lightbulb, Save } from 'lucide-react';
import Box from '@mui/material/Box';
import Typography from '@mui/material/Typography';
import TextField from '@mui/material/TextField';
import Alert from '@mui/material/Alert';
import Chip from '@mui/material/Chip';
import { AppButton } from '@/components/material/AppButton';
import { AppDialog } from '@/components/material/AppDialog';
import type { ExternalReadingDetail } from './RadarExternalReadingLanding';

interface Judgment {
  id: string; title: string; conclusion: string; updatedAt: string; private: boolean; matchReason: string;
}

export function PreviousJudgments({ radarSummaryId, topicId, enabled }: {
  radarSummaryId?: string; topicId?: string; enabled: boolean;
}) {
  const [items, setItems] = useState<Judgment[]>([]);
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    const refresh = () => setRevision(value => value + 1);
    window.addEventListener('dr-knowledge-saved', refresh);
    return () => window.removeEventListener('dr-knowledge-saved', refresh);
  }, []);
  useEffect(() => {
    setItems([]);
    if (!enabled) return;
    const params = new URLSearchParams(radarSummaryId ? { radarSummaryId } : { topicId: topicId! });
    const controller = new AbortController();
    void fetch(`/api/knowledge/related?${params}`, { signal: controller.signal, cache: 'no-store' })
      .then(async response => response.ok ? response.json() : { items: [] })
      .then(data => { if (!controller.signal.aborted) setItems(data.items ?? []); })
      .catch(() => undefined);
    return () => controller.abort();
  }, [radarSummaryId, topicId, enabled, revision]);
  if (!enabled || !items.length) return null;
  return <Box component="section" aria-label="你之前的判断" sx={{ borderTop: 1, borderColor: 'divider', pt: 2, mt: 2 }}>
    <Typography component="h2" variant="fieldTitle">你之前的判断</Typography>
    {items.slice(0, 3).map(item => <Box key={item.id} sx={{ mt: 1.5 }}>
      <Typography component={Link} href={`/researches/${item.id}`} variant="body2" sx={{ color: 'primary.main', textDecoration: 'none', '&:hover': { textDecoration: 'underline' } }}>{item.title}</Typography>
      <Typography component="p" variant="body2" color="text.secondary" sx={{ mt: 0.5, overflowWrap: 'anywhere', whiteSpace: 'pre-line' }}>{item.conclusion}</Typography>
      <Box sx={{ display: 'flex', gap: 1, alignItems: 'center', mt: 0.5 }}>
        <Typography variant="metadata" color="text.secondary">{item.matchReason} · {new Date(item.updatedAt).toLocaleDateString('zh-CN')}</Typography>
        {item.private ? <Chip size="small" label="仅本人" variant="outlined" /> : null}
      </Box>
    </Box>)}
  </Box>;
}

export function RadarKnowledgeActions({ detail }: { detail: ExternalReadingDetail }) {
  const [open, setOpen] = useState(false);
  const [note, setNote] = useState('');
  const [quote, setQuote] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [savedId, setSavedId] = useState('');
  const saveKey = useRef('');
  const pending = useRef(false);

  function start() {
    const selection = window.getSelection();
    const root = document.querySelector(`[data-radar-knowledge-id="${detail.id}"]`);
    const selected = root && selection?.anchorNode && selection.focusNode
      && root.contains(selection.anchorNode) && root.contains(selection.focusNode) ? selection.toString().trim() : '';
    setQuote((selected || detail.interpretation || detail.excerpt || detail.title).slice(0, 12000));
    setNote('');
    setError('');
    setSavedId('');
    saveKey.current = crypto.randomUUID();
    setOpen(true);
  }

  async function save() {
    if (!note.trim() || pending.current) return;
    pending.current = true;
    setSaving(true);
    setError('');
    try {
      const response = await fetch('/api/reading/save', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          url: detail.url, radarSummaryId: detail.id, title: detail.title,
          quote, note: note.trim(), tags: [], idempotencyKey: saveKey.current,
        }),
      });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.message || '保存失败，请重试');
      setSavedId(payload.draft.id);
      window.dispatchEvent(new Event('dr-knowledge-saved'));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '保存失败，请重试');
    } finally {
      pending.current = false;
      setSaving(false);
    }
  }

  if (!detail.isAuthenticated) return null;
  return <>
    <AppButton variant="outlined" startIcon={<Lightbulb aria-hidden />} onClick={start}>记录判断</AppButton>
    <AppDialog open={open} onClose={() => { if (!saving) setOpen(false); }} title="记录判断"
      actions={savedId
        ? <AppButton component={Link} href={`/researches/${savedId}`} variant="contained">查看知识卡</AppButton>
        : <><AppButton onClick={() => setOpen(false)} disabled={saving} color="inherit">取消</AppButton><AppButton variant="contained" startIcon={<Save aria-hidden />} disabled={!note.trim() || saving} onClick={() => void save()}>{saving ? '保存中…' : '保存判断'}</AppButton></>}>
      {savedId ? <Alert severity="success">已保存，仅你可见。</Alert> : <Box sx={{ display: 'grid', gap: 2, pt: 1 }}>
        <Typography component="a" href={detail.url} target="_blank" rel="noopener noreferrer" variant="body2" sx={{ color: 'primary.main', overflowWrap: 'anywhere' }}>{detail.title}</Typography>
        <TextField label="来源摘录 / AI 摘要" multiline minRows={2} maxRows={5} value={quote} slotProps={{ htmlInput: { readOnly: true } }} fullWidth />
        <TextField label="我的判断" autoFocus multiline minRows={3} value={note} onChange={event => setNote(event.target.value)} disabled={saving} slotProps={{ htmlInput: { maxLength: 8000 } }} fullWidth />
        {error ? <Alert severity="error">{error}</Alert> : null}
      </Box>}
    </AppDialog>
  </>;
}
