import React, { useEffect, useState } from 'react';
import Menu from '@mui/material/Menu';
import MenuItem from '@mui/material/MenuItem';
import Typography from '@mui/material/Typography';
import ListSubheader from '@mui/material/ListSubheader';
import Divider from '@mui/material/Divider';
import { ReaderButton } from './reader-controls';
import { ComposerIcon } from './reader-header';
import { t, getUiLanguage } from '../i18n.js';
import { TRANSLATION_LANGUAGES, resolveTranslationLanguage } from '../translation-language.js';

export function TranslationLanguagePicker() {
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);
  const [state, setState] = useState({ value: 'interface', disabled: false, visible: true });
  useEffect(() => {
    const update = (event: Event) => setState((event as CustomEvent).detail);
    window.addEventListener('reader:translation-language-state', update);
    return () => window.removeEventListener('reader:translation-language-state', update);
  }, []);
  const language = resolveTranslationLanguage(state.value, getUiLanguage());
  const target = TRANSLATION_LANGUAGES.find(item => item.value === language)!;
  const choose = (value: string) => {
    setAnchor(null);
    window.dispatchEvent(new CustomEvent('reader:translation-language-change', { detail: value }));
  };
  if (!state.visible) return null;
  return <>
    <ReaderButton id="translation-language-button" control="compact" disabled={state.disabled} aria-label={t('翻译目标语言：{0}', target.label)} title={t('翻译目标语言：{0}', target.label)} aria-haspopup="menu" aria-expanded={Boolean(anchor)} aria-controls={anchor ? 'translation-language-menu' : undefined} onClick={event => setAnchor(event.currentTarget)} endIcon={<ComposerIcon kind="chevron-down" size={20} />} sx={{ whiteSpace: 'nowrap', minWidth: 44, px: 0.5 }}>{target.short}</ReaderButton>
    <Menu id="translation-language-menu" anchorEl={anchor} open={Boolean(anchor)} onClose={() => setAnchor(null)} slotProps={{ list: { 'aria-label': t('翻译目标语言'), subheader: <ListSubheader component="div">{t('翻译目标语言')}</ListSubheader> }, paper: { sx: { maxHeight: 'min(440px, 75dvh)', width: 240 } } }}>
      <MenuItem selected={state.value === 'interface'} onClick={() => choose('interface')}>{t('跟随界面语言')}</MenuItem>
      <Divider />
      {TRANSLATION_LANGUAGES.map(item => <MenuItem key={item.value} selected={state.value === item.value} onClick={() => choose(item.value)} lang={item.value}>{item.label}</MenuItem>)}
      <Typography component="li" variant="caption" color="text.secondary" sx={{ px: 2, py: 1, listStyle: 'none' }}>{t('用于全文、选段和图片文字翻译；不改变聊天回答语言。')}</Typography>
    </Menu>
  </>;
}
