import React, { useEffect, useState } from 'react';
import { flushSync } from 'react-dom';
import Checkbox from '@mui/material/Checkbox';
import FormControlLabel from '@mui/material/FormControlLabel';
import Stack from '@mui/material/Stack';
import { t } from '../i18n.js';

interface SaveOptions {
  highlight: boolean; includeAI: boolean; sync: boolean;
  highlightAvailable: boolean; aiAvailable: boolean; syncAvailable: boolean;
}

export function ReadingSaveOptions() {
  const [options, setOptions] = useState<SaveOptions>({ highlight: false, includeAI: false, sync: false, highlightAvailable: false, aiAvailable: false, syncAvailable: false });
  useEffect(() => {
    const update = (event: Event) => flushSync(() => setOptions((event as CustomEvent<SaveOptions>).detail));
    window.addEventListener('reader:save-options-state', update);
    return () => window.removeEventListener('reader:save-options-state', update);
  }, []);
  const change = (key: 'highlight' | 'includeAI' | 'sync', checked: boolean) => {
    const next = { ...options, [key]: checked };
    setOptions(next);
    window.dispatchEvent(new CustomEvent('reader:save-options-change', { detail: next }));
  };
  return <Stack role="group" aria-label={t('保存选项')} sx={{ my: 1, '& .MuiFormControlLabel-root': { minHeight: 44, m: 0 } }}>
    <FormControlLabel control={<Checkbox id="save-highlight" checked={options.highlight} disabled={!options.highlightAvailable} onChange={(_, value) => change('highlight', value)} />} label={t('在原文高亮')} />
    <FormControlLabel control={<Checkbox id="save-include-ai" checked={options.includeAI} disabled={!options.aiAvailable} onChange={(_, value) => change('includeAI', value)} />} label={t('附带 AI 解读')} />
    <FormControlLabel control={<Checkbox id="save-sync" checked={options.sync} disabled={!options.syncAvailable} onChange={(_, value) => change('sync', value)} />} label={t('同步到研究库')} />
  </Stack>;
}
