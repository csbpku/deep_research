'use client';

import React, { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { Lightbulb, Save, Trash2 } from 'lucide-react';
import Box from '@mui/material/Box';
import Typography from '@mui/material/Typography';
import TextField from '@mui/material/TextField';
import Alert from '@mui/material/Alert';
import Chip from '@mui/material/Chip';
import { AppButton } from '@/components/material/AppButton';
import { AppDialog } from '@/components/material/AppDialog';
import type { ExternalReadingDetail } from './RadarExternalReadingLanding';
import {
  clearJudgmentDraft,
  readJudgmentDraft,
  writeJudgmentDraft,
} from '@/lib/radar-judgment-draft';

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
  return <Box component="section" aria-label="你之前的笔记" sx={{ borderTop: 1, borderColor: 'divider', pt: 2, mt: 2 }}>
    <Typography component="h2" variant="fieldTitle">你之前的笔记</Typography>
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
  const [restoredDraft, setRestoredDraft] = useState(false);
  const saveKey = useRef('');
  const pending = useRef(false);
  const noteRef = useRef<HTMLTextAreaElement | null>(null);

  function start() {
    const selection = window.getSelection();
    const root = document.querySelector(`[data-radar-knowledge-id="${detail.id}"]`);
    const selected = root && selection?.anchorNode && selection.focusNode
      && root.contains(selection.anchorNode) && root.contains(selection.focusNode) ? selection.toString().trim() : '';
    setQuote((selected || detail.interpretation || detail.excerpt || detail.title).slice(0, 12000));
    // 未提交的判断按 radarSummaryId 保留：关掉对话框不该抹掉用户写好的东西。
    const draft = readJudgmentDraft(detail.id);
    setNote(draft?.note ?? '');
    setRestoredDraft(Boolean(draft));
    setError('');
    setSavedId('');
    saveKey.current = crypto.randomUUID();
    setOpen(true);
  }

  function updateNote(value: string) {
    setNote(value);
    setRestoredDraft(false);
    writeJudgmentDraft(detail.id, value);
  }

  function discardDraft() {
    clearJudgmentDraft(detail.id);
    setNote('');
    setRestoredDraft(false);
    // 丢弃按钮自己会被卸载，焦点必须交回输入框：否则焦点掉到 body，
    // Escape 不再触发对话框的关闭。
    noteRef.current?.focus();
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
      clearJudgmentDraft(detail.id);
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
    <AppButton variant="outlined" startIcon={<Lightbulb aria-hidden />} onClick={start}>写笔记</AppButton>
    <AppDialog open={open} onClose={() => { if (!saving) setOpen(false); }} title="写笔记"
      actions={savedId
        ? <AppButton component={Link} href={`/researches/${savedId}`} variant="contained">查看知识卡</AppButton>
        : <><AppButton onClick={() => setOpen(false)} disabled={saving} color="inherit">取消</AppButton><AppButton variant="contained" startIcon={<Save aria-hidden />} disabled={!note.trim() || saving} onClick={() => void save()}>{saving ? '保存中…' : '保存笔记'}</AppButton></>}>
      {savedId ? <Alert severity="success">已保存，仅你可见。</Alert> : <Box sx={{ display: 'grid', gap: 2, pt: 1 }}>
        <Typography component="a" href={detail.url} target="_blank" rel="noopener noreferrer" variant="body2" sx={{ color: 'primary.main', overflowWrap: 'anywhere' }}>{detail.title}</Typography>
        <TextField label="来源摘录 / AI 摘要" multiline minRows={2} maxRows={5} value={quote} slotProps={{ htmlInput: { readOnly: true } }} fullWidth />
        <TextField
          label="我的笔记"
          autoFocus
          inputRef={noteRef}
          multiline
          minRows={3}
          value={note}
          onChange={event => updateNote(event.target.value)}
          onKeyDown={event => {
            if ((event.metaKey || event.ctrlKey) && event.key === 'Enter' && note.trim() && !saving) {
              event.preventDefault();
              void save();
            }
          }}
          disabled={saving}
          slotProps={{ htmlInput: { maxLength: 8000 } }}
          fullWidth
        />
        {restoredDraft ? (
          <Alert
            severity="info"
            action={
              <AppButton size="small" color="inherit" startIcon={<Trash2 aria-hidden />} onClick={discardDraft}>
                丢弃草稿
              </AppButton>
            }
          >
            草稿已保留。
          </Alert>
        ) : null}
        {error ? <Alert severity="error">{error}</Alert> : null}
      </Box>}
    </AppDialog>
  </>;
}
