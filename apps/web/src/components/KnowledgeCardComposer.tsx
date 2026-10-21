'use client';

import Link from 'next/link';
import { useEffect, useRef, useState } from 'react';
import { Check, Lightbulb, RotateCw, X } from 'lucide-react';
import Box from '@mui/material/Box';
import CircularProgress from '@mui/material/CircularProgress';
import FormLabel from '@mui/material/FormLabel';
import MaterialLink from '@mui/material/Link';
import OutlinedInput from '@mui/material/OutlinedInput';
import Paper from '@mui/material/Paper';
import Typography from '@mui/material/Typography';
import { space, tokens } from '@deep-research/design-system';

import { AppButton, AppIconButton } from '@/components/material/AppButton';
import { AppTextField } from '@/components/material/AppTextField';
import { friendlyMessage } from '@/lib/errors/friendly';
import { toApiHttpError } from '@/lib/errors/api-error';
import type { KnowledgeSourceKind } from '@/lib/knowledge-card';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

interface Preview {
  title: string;
  body: string;
  conclusion: string;
  tags: string[];
}

export function KnowledgeCardComposer({
  sourceKind,
  messageId,
}: {
  sourceKind: KnowledgeSourceKind;
  messageId: string;
}) {
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [conclusion, setConclusion] = useState('');
  const [tags, setTags] = useState('');
  const [savedId, setSavedId] = useState<string | null>(null);
  const [selectedText, setSelectedText] = useState('');
  const [derivedFromText, setDerivedFromText] = useState('');
  const deriveInFlight = useRef(false);
  const confirmationKey = useRef('');

  useEffect(() => {
    function updateSelection(event: Event) {
      if (event.target instanceof Element && event.target.closest('[data-knowledge-card-composer]')) return;
      const selection = window.getSelection();
      const root = Array.from(document.querySelectorAll<HTMLElement>('[data-knowledge-source-message]'))
        .find((element) => element.dataset.knowledgeSourceMessage === messageId);
      const elementFor = (node: Node | null) => node instanceof Element ? node : node?.parentElement ?? null;
      const anchor = elementFor(selection?.anchorNode ?? null);
      const focus = elementFor(selection?.focusNode ?? null);
      if (!root || !selection || !anchor || !focus || !root.contains(anchor) || !root.contains(focus)) {
        setSelectedText('');
        return;
      }
      setSelectedText(selection.toString().trim().slice(0, 5_000));
    }
    document.addEventListener('mouseup', updateSelection);
    document.addEventListener('keyup', updateSelection);
    return () => {
      document.removeEventListener('mouseup', updateSelection);
      document.removeEventListener('keyup', updateSelection);
    };
  }, [messageId]);

  if (!UUID_RE.test(messageId)) return null;

  async function derive() {
    if (deriveInFlight.current) return;
    const sourceText = selectedText;
    if (sourceText.length < 8) return;
    deriveInFlight.current = true;
    confirmationKey.current = crypto.randomUUID();
    setOpen(true);
    setLoading(true);
    setError(null);
    setDerivedFromText(sourceText);
    try {
      const response = await fetch('/api/knowledge/derive', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ sourceKind, messageId, selectedText: sourceText }),
      });
      if (!response.ok) {
        throw new Error(friendlyMessage(await toApiHttpError(response, '提炼失败'), '提炼失败，请稍后重试。'));
      }
      const payload = await response.json() as { preview?: Preview };
      if (!payload.preview?.title || !payload.preview.body) throw new Error('没有生成有效的知识卡片预览');
      setPreview(payload.preview);
      setTitle(payload.preview.title);
      setBody(payload.preview.body);
      setConclusion(payload.preview.conclusion ?? '');
      setTags(payload.preview.tags.join('、'));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '提炼失败，请稍后重试。');
    } finally {
      deriveInFlight.current = false;
      setLoading(false);
    }
  }

  async function save() {
    const normalizedTitle = title.trim();
    const normalizedBody = body.trim();
    if (!normalizedTitle || !normalizedBody || saving) return;
    setSaving(true);
    setError(null);
    try {
      const response = await fetch('/api/knowledge', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          sourceKind,
          messageId,
          selectedText: derivedFromText,
          title: normalizedTitle,
          body: normalizedBody,
          conclusion: conclusion.trim(),
          tags: tags.split(/[,，、]/u).map((tag) => tag.trim()).filter(Boolean).slice(0, 10),
          idempotencyKey: confirmationKey.current,
        }),
      });
      if (!response.ok) {
        throw new Error(friendlyMessage(await toApiHttpError(response, '保存失败'), '保存失败，请稍后重试。'));
      }
      const payload = await response.json() as { knowledge?: { id?: string } };
      if (!payload.knowledge?.id) throw new Error('保存结果无效，请稍后查看研究库');
      setSavedId(payload.knowledge.id);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '保存失败，请稍后重试。');
    } finally {
      setSaving(false);
    }
  }

  return (
    <Box sx={{ mt: space.sm }} data-knowledge-card-composer="true">
      {savedId ? (
        <Typography component="p" variant="metadata" color="success.main" sx={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: space.xs }}>
          <Check aria-hidden="true" size={14} />
          已保存知识卡片
          <MaterialLink component={Link} href={`/researches/${savedId}`} underline="hover" color="primary.main" sx={{ fontWeight: 500 }}>查看</MaterialLink>
        </Typography>
      ) : (
        <>
          {!open && selectedText.length >= 8 ? (
            <AppButton type="button" variant="text" size="small" onClick={() => void derive()}>
              <Lightbulb aria-hidden="true" />
              存为知识
            </AppButton>
          ) : null}
          {open ? (
            <Paper variant="outlined" sx={{ display: 'grid', gap: space.md, p: space.md, borderLeftWidth: 2, borderLeftColor: 'var(--dr-color-inference)', bgcolor: 'var(--dr-color-inference-container)' }}>
              <Box sx={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: space.sm }}>
                <Box sx={{ minWidth: 0 }}>
                  <Typography variant="fieldTitle">知识卡片预览</Typography>
                  <Typography variant="metadata" color="text.secondary" sx={{ mt: space.xs }}>仅根据所选判断生成；保存后是私人草稿。</Typography>
                </Box>
                <AppIconButton
                  type="button"
                  size="small"
                  aria-label="关闭知识卡片预览"
                  onClick={() => { setOpen(false); setError(null); }}
                >
                  <X aria-hidden="true" />
                </AppIconButton>
              </Box>
              <Box component="blockquote"
                aria-label="本次提炼所选原文"
                title={derivedFromText}
                sx={{ m: 0, pl: space.sm, borderLeft: 2, borderColor: 'var(--dr-color-inference)', color: 'text.secondary', typography: 'metadata', lineHeight: tokens['line-height-body'] }}
              >
                {derivedFromText.length > 360 ? `${derivedFromText.slice(0, 360)}…` : derivedFromText}
              </Box>
              {loading ? (
                <Box sx={{ display: 'flex', alignItems: 'center', gap: space.sm, color: 'text.secondary', typography: 'metadata' }} role="status">
                  <CircularProgress aria-hidden="true" size={14} color="inherit" />
                  正在提炼…
                </Box>
              ) : preview ? (
                <Box sx={{ display: 'grid', gap: space.sm }}>
                  <Box sx={{ display: 'grid', gap: space.xs }}>
                    <FormLabel htmlFor={`knowledge-title-${messageId}`} sx={{ typography: 'metadata', fontWeight: 500, color: 'text.primary' }}>标题</FormLabel>
                    <AppTextField id={`knowledge-title-${messageId}`} value={title} onChange={(event) => setTitle(event.target.value)} maxLength={300} sx={{ fontSize: tokens['type-caption'] }} />
                  </Box>
                  <Box sx={{ display: 'grid', gap: space.xs }}>
                    <FormLabel htmlFor={`knowledge-body-${messageId}`} sx={{ typography: 'metadata', fontWeight: 500, color: 'text.primary' }}>核心结论</FormLabel>
                    <OutlinedInput id={`knowledge-body-${messageId}`} fullWidth multiline rows={4} value={body} onChange={(event) => setBody(event.target.value)} inputProps={{ maxLength: 50_000 }} sx={{ alignItems: 'flex-start', fontSize: tokens['type-caption'], lineHeight: tokens['line-height-body'] }} />
                  </Box>
                  <Box sx={{ display: 'grid', gap: space.xs }}>
                    <FormLabel htmlFor={`knowledge-conclusion-${messageId}`} sx={{ typography: 'metadata', fontWeight: 500, color: 'text.primary' }}>一句话结论</FormLabel>
                    <AppTextField id={`knowledge-conclusion-${messageId}`} value={conclusion} onChange={(event) => setConclusion(event.target.value)} maxLength={2_000} sx={{ fontSize: tokens['type-caption'] }} />
                  </Box>
                  <Box sx={{ display: 'grid', gap: space.xs }}>
                    <FormLabel htmlFor={`knowledge-tags-${messageId}`} sx={{ typography: 'metadata', fontWeight: 500, color: 'text.primary' }}>标签</FormLabel>
                    <AppTextField id={`knowledge-tags-${messageId}`} value={tags} onChange={(event) => setTags(event.target.value)} placeholder="用顿号或逗号分隔" maxLength={400} sx={{ fontSize: tokens['type-caption'] }} />
                  </Box>
                  {error ? <Typography role="alert" variant="metadata" color="error.main">{error}</Typography> : null}
                  <Box sx={{ display: 'flex', flexWrap: 'wrap', justifyContent: 'flex-end', gap: space.sm, pt: space.xs }}>
                    <AppButton type="button" variant="text" size="small" onClick={() => { setOpen(false); setPreview(null); setError(null); }} disabled={saving}>取消</AppButton>
                    <AppButton type="button" variant="contained" size="small" onClick={() => void save()} disabled={derivedFromText.length < 8 || !title.trim() || !body.trim() || saving}>
                      {saving ? <CircularProgress aria-hidden="true" size={14} color="inherit" /> : <Check aria-hidden="true" />}
                      {saving ? '保存中…' : '保存知识卡片'}
                    </AppButton>
                  </Box>
                </Box>
              ) : (
                <Box sx={{ display: 'grid', gap: space.sm }}>
                  <Typography
                    role={error ? 'alert' : 'status'}
                    variant="metadata"
                    color={error ? 'error.main' : 'text.secondary'}
                  >
                    {error ?? '正在准备预览…'}
                  </Typography>
                  {error ? (
                    <Box sx={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: space.sm }}>
                      <AppButton type="button" size="small" variant="outlined" onClick={() => void derive()} disabled={loading}>
                        {loading ? <CircularProgress aria-hidden="true" size={14} color="inherit" /> : <RotateCw aria-hidden="true" />}
                        重试提炼
                      </AppButton>
                      <AppButton
                        type="button"
                        size="small"
                        variant="text"
                        onClick={() => { setOpen(false); setError(null); }}
                        disabled={loading}
                      >
                        关闭
                      </AppButton>
                    </Box>
                  ) : null}
                </Box>
              )}
            </Paper>
          ) : null}
        </>
      )}
    </Box>
  );
}
