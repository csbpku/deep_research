'use client';

import React, { useEffect, useState } from 'react';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Stack from '@mui/material/Stack';
import Typography from '@mui/material/Typography';

import type { SelfCheckItem } from '@/lib/research-self-check';

export interface LearningSelfCheckProps {
  items: SelfCheckItem[];
  /** Research id keeps one article's review queue from leaking into another. */
  researchId?: string;
}

export type SelfCheckRating = 'got_it' | 'unsure' | 'missed';

const STORAGE_KEY = 'deep-research.self-check.v1';

function storageKey(researchId?: string): string {
  return researchId ? `${STORAGE_KEY}.${researchId}` : STORAGE_KEY;
}

const RATINGS: Array<{ value: SelfCheckRating; label: string }> = [
  { value: 'got_it', label: '会' },
  { value: 'unsure', label: '不确定' },
  { value: 'missed', label: '不会' },
];

const RATING_LABELS: Record<SelfCheckRating, string> = {
  got_it: '会',
  unsure: '不确定',
  missed: '不会',
};

function readRatings(key: string): Record<string, SelfCheckRating> {
  try {
    const raw = window.localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as Record<string, SelfCheckRating>) : {};
  } catch {
    return {};
  }
}

function writeRatings(key: string, ratings: Record<string, SelfCheckRating>): void {
  try {
    window.localStorage.setItem(key, JSON.stringify(ratings));
  } catch {
    // Storage can be unavailable in private mode; the rating still applies this session.
  }
}

/** Answers stay hidden until the reader commits to an attempt and rates it. */
export function LearningSelfCheck({ items, researchId }: LearningSelfCheckProps) {
  const key = storageKey(researchId);
  const [open, setOpen] = useState<Set<string>>(new Set());
  const [ratings, setRatings] = useState<Record<string, SelfCheckRating>>({});

  useEffect(() => {
    const stored = readRatings(key);
    setRatings(stored);
    // A rated question already had its attempt; restore its answer on return.
    setOpen(new Set(Object.keys(stored)));
  }, [key]);

  if (items.length === 0) return null;

  const rate = (question: string, rating: SelfCheckRating) => {
    const next = { ...ratings, [question]: rating };
    setRatings(next);
    writeRatings(key, next);
    setOpen(prev => new Set(prev).add(question));
  };

  const due = items.filter(item => ratings[item.question] === 'unsure' || ratings[item.question] === 'missed').length;

  return (
    <Stack spacing={2} component="section" aria-label="学习自检" sx={{ mt: 2 }}>
      {due > 0 && (
        <Typography variant="caption" color="warning.main" data-testid="self-check-due">
          还有 {due} 道题需要复习：标为“不确定”或“不会”的题已排进待复习。
        </Typography>
      )}
      {items.map((item, index) => {
        const visible = open.has(item.question);
        const rating = ratings[item.question];
        return (
          <Box key={item.question} data-testid="learning-self-check-item">
            <Typography component="p" sx={{ fontWeight: 600 }}>
              {index + 1}. {item.question}
            </Typography>
            {!visible && (
              <Stack direction="row" spacing={1} sx={{ mt: 0.5, alignItems: 'center', flexWrap: 'wrap' }} aria-label="自评">
                <Typography variant="caption" color="text.secondary">
                  先想一想，你的把握是？
                </Typography>
                {RATINGS.map(option => (
                  <Button
                    key={option.value}
                    size="small"
                    variant="outlined"
                    onClick={() => rate(item.question, option.value)}
                  >
                    {option.label}
                  </Button>
                ))}
              </Stack>
            )}
            {visible && (
              <>
                {rating && (
                  <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 0.75 }}>
                    你的自评：{RATING_LABELS[rating]}
                  </Typography>
                )}
                <Typography component="p" sx={{ mt: 0.5, color: 'text.secondary' }}>
                  {item.answer}
                </Typography>
              </>
            )}
          </Box>
        );
      })}
    </Stack>
  );
}
