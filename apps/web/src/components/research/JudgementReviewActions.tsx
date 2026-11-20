'use client';

import { DEFAULT_JUDGEMENT_REVIEW_DAYS, JUDGEMENT_REVIEW_PRESETS, reviewDateFromNow } from '@/lib/research-review-policy';
import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { useQueryClient } from '@tanstack/react-query';
import { Alert, Box, Stack, TextField, Typography } from '@mui/material';
import { AppButton } from '@/components/material/AppButton';
import { AppDialog } from '@/components/material/AppDialog';
import { KnowledgeJudgementForm, type KnowledgeJudgementDraft } from './KnowledgeJudgementForm';

/** A due judgement is a decision, not a badge: reaffirm it (with a new
 *  expiry), revise the wording, or archive the card. */

export function JudgementReviewActions({ researchId, initialJudgement }: {
  researchId: string;
  initialJudgement: KnowledgeJudgementDraft;
}) {
  const router = useRouter();
  const queryClient = useQueryClient();
  const [mode, setMode] = useState<'reaffirm' | 'revise' | null>(null);
  const [draft, setDraft] = useState(initialJudgement);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [reviewAt, setReviewAt] = useState(() => reviewDateFromNow(DEFAULT_JUDGEMENT_REVIEW_DAYS));

  async function post(action: 'reaffirm' | 'revise' | 'archive', body: Record<string, unknown> = {}) {
    setBusy(true);
    setError(null);
    try {
      const response = await fetch(`/api/researches/${researchId}/judgement`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ action, ...body }),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(typeof data.message === 'string' ? data.message : `请求失败（${response.status}）`);
      await queryClient.invalidateQueries({ queryKey: ['research', researchId] });
      await queryClient.invalidateQueries({ queryKey: ['researches'] });
      await queryClient.invalidateQueries({ queryKey: ['review-queue'] });
      await queryClient.invalidateQueries({ queryKey: ['review-queue-count'] });
      setMode(null);
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : '请求失败');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Box>
      <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1}>
        <AppButton size="small" variant="contained" disabled={busy} onClick={() => { setError(null); setMode('reaffirm'); }}>
          判断仍成立
        </AppButton>
        <AppButton size="small" variant="outlined" disabled={busy} onClick={() => {
          setError(null);
          setDraft({ ...initialJudgement, judgementReviewAt: reviewDateFromNow(DEFAULT_JUDGEMENT_REVIEW_DAYS) });
          setMode('revise');
        }}>
          需要修订
        </AppButton>
        <AppButton size="small" variant="outlined" color="warning" disabled={busy} onClick={() => void post('archive')}>
          归档
        </AppButton>
      </Stack>
      {error && !mode ? <Alert severity="error" sx={{ mt: 1 }}>{error}</Alert> : null}
      <AppDialog
        open={mode !== null}
        onClose={() => { if (!busy) setMode(null); }}
        title={mode === 'revise' ? '修订知识卡判断' : '确认判断仍成立'}
        actions={
          <>
            <AppButton variant="text" onClick={() => setMode(null)} disabled={busy}>取消</AppButton>
            <AppButton variant="contained" disabled={busy || !(mode === 'revise' ? draft.judgementReviewAt : reviewAt)} onClick={() => {
              if (mode === 'revise') {
                void post('revise', { ...draft, judgementReviewAt: new Date(draft.judgementReviewAt).toISOString() });
              } else {
                void post('reaffirm', { reviewAt: new Date(reviewAt).toISOString() });
              }
            }}>
              {mode === 'revise' ? '保存修订并设置复查' : '确认并顺延'}
            </AppButton>
          </>
        }
      >
        <Stack spacing={2}>
          {mode === 'revise' ? (
            <KnowledgeJudgementForm value={draft} onChange={setDraft} disabled={busy} />
          ) : (
            <>
              <Typography variant="body2" color="text.secondary">
                确认这条判断仍然成立，并选择下一次复查时间。修改记录会写入审计。
              </Typography>
              <Stack direction="row" spacing={1}>
                {JUDGEMENT_REVIEW_PRESETS.map((days) => (
                  <AppButton
                    key={days}
                    type="button"
                    size="small"
                    variant={reviewAt === reviewDateFromNow(days) ? 'contained' : 'outlined'}
                    onClick={() => setReviewAt(reviewDateFromNow(days))}
                  >
                    {days} 天
                  </AppButton>
                ))}
              </Stack>
              <TextField
                type="date"
                label="下一次复查"
                value={reviewAt}
                onChange={(event) => setReviewAt(event.target.value)}
                slotProps={{
                  inputLabel: { shrink: true },
                  htmlInput: { min: new Date(Date.now() + 86400000).toISOString().slice(0, 10) },
                }}
                fullWidth
              />
            </>
          )}
          {error ? <Alert severity="error">{error}</Alert> : null}
        </Stack>
      </AppDialog>
    </Box>
  );
}
