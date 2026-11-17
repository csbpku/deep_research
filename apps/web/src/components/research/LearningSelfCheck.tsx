'use client';

import React, { useState } from 'react';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Stack from '@mui/material/Stack';
import Typography from '@mui/material/Typography';

import type { SelfCheckItem } from '@/lib/research-self-check';

export interface LearningSelfCheckProps {
  items: SelfCheckItem[];
}

/** Answers stay hidden until the reader commits to an attempt. */
export function LearningSelfCheck({ items }: LearningSelfCheckProps) {
  const [open, setOpen] = useState<Set<number>>(new Set());
  if (items.length === 0) return null;
  const reveal = (index: number) => setOpen(prev => new Set(prev).add(index));

  return (
    <Stack spacing={2} component="section" aria-label="学习自检" sx={{ mt: 2 }}>
      {items.map((item, index) => {
        const visible = open.has(index);
        return (
          <Box key={item.question} data-testid="learning-self-check-item">
            <Typography component="p" sx={{ fontWeight: 600 }}>
              {index + 1}. {item.question}
            </Typography>
            {visible ? (
              <Typography component="p" sx={{ mt: 0.75, color: 'text.secondary' }}>
                {item.answer}
              </Typography>
            ) : (
              <Button
                size="small"
                variant="text"
                sx={{ mt: 0.5, px: 0 }}
                onClick={() => reveal(index)}
              >
                先想一想，再显示答案要点
              </Button>
            )}
          </Box>
        );
      })}
    </Stack>
  );
}
