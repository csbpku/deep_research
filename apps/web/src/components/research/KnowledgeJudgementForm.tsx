'use client';

import React from 'react';
import Box from '@mui/material/Box';
import Typography from '@mui/material/Typography';
import TextField from '@mui/material/TextField';
import MenuItem from '@mui/material/MenuItem';
import { JUDGEMENT_CONFIDENCES, JUDGEMENT_CONFIDENCE_LABELS, type JudgementConfidence } from '@/lib/research-knowledge-judgement';

export interface KnowledgeJudgementDraft {
  judgement: string;
  judgementConfidence: JudgementConfidence;
  judgementScope: string;
  judgementReviewAt: string;
}

export const EMPTY_JUDGEMENT: KnowledgeJudgementDraft = {
  judgement: '', judgementConfidence: 'medium', judgementScope: '', judgementReviewAt: '',
};

export function KnowledgeJudgementForm({ value, onChange, disabled }: {
  value: KnowledgeJudgementDraft;
  onChange: (next: KnowledgeJudgementDraft) => void;
  disabled?: boolean;
}) {
  const update = <K extends keyof KnowledgeJudgementDraft>(key: K, next: KnowledgeJudgementDraft[K]) =>
    onChange({ ...value, [key]: next });
  return (
    <Box sx={{ display: 'grid', gap: 2, textAlign: 'left' }}>
      <Typography variant="metadata" color="text.secondary">
        发布后读者看到的是“你愿意为之负责的判断”，而不只是你读过什么。
      </Typography>
      <TextField
        label="判断"
        required
        multiline
        minRows={2}
        value={value.judgement}
        onChange={event => update('judgement', event.target.value)}
        disabled={disabled}
        helperText="一句可被检验的结论。例如：它更适合跨仓库查调用关系，不适合替代逐行 review。"
        slotProps={{ htmlInput: { maxLength: 500 } }}
      />
      <TextField
        select
        label="置信度"
        value={value.judgementConfidence}
        onChange={event => update('judgementConfidence', event.target.value as JudgementConfidence)}
        disabled={disabled}
      >
        {JUDGEMENT_CONFIDENCES.map(level => (
          <MenuItem key={level} value={level}>{JUDGEMENT_CONFIDENCE_LABELS[level]}</MenuItem>
        ))}
      </TextField>
      <TextField
        label="适用边界"
        required
        multiline
        minRows={2}
        value={value.judgementScope}
        onChange={event => update('judgementScope', event.target.value)}
        disabled={disabled}
        helperText="什么条件下成立、什么条件下会失效。"
        slotProps={{ htmlInput: { maxLength: 500 } }}
      />
      <TextField
        label="复查时间"
        type="date"
        required
        value={value.judgementReviewAt}
        onChange={event => update('judgementReviewAt', event.target.value)}
        disabled={disabled}
        slotProps={{ inputLabel: { shrink: true } }}
        helperText="到期后这条判断会进入待复习。"
      />
    </Box>
  );
}
