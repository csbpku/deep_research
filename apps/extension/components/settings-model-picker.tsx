import React, { useLayoutEffect, useState } from 'react';
import { flushSync } from 'react-dom';
import Autocomplete, { createFilterOptions } from '@mui/material/Autocomplete';
import TextField from '@mui/material/TextField';
import Box from '@mui/material/Box';
import Typography from '@mui/material/Typography';
import { t } from '../i18n.js';

interface ModelOption { id: string; label: string }
interface ModelState { options: ModelOption[]; value: string; loading: boolean }
const filterOptions = createFilterOptions<ModelOption>({ stringify: option => `${option.label} ${option.id}` });

export function SettingsModelPicker() {
  const [state, setState] = useState<ModelState>({ options: [], value: '', loading: false });
  useLayoutEffect(() => {
    const update = (event: Event) => flushSync(() => setState((event as CustomEvent<ModelState>).detail));
    window.addEventListener('reader:settings-model-state', update);
    return () => window.removeEventListener('reader:settings-model-state', update);
  }, []);
  return <>
    {/* The controller owns this stable value contract; the visible picker is React-owned. */}
    <select id="provider-model-list" className="hidden" aria-hidden="true" tabIndex={-1} defaultValue=""><option value="" /></select>
    <Autocomplete<ModelOption> id="provider-model-search" options={state.options}
      value={state.options.find(option => option.id === state.value) || null}
      isOptionEqualToValue={(a, b) => a.id === b.id} getOptionLabel={option => option.label}
      getOptionKey={option => option.id}
      filterOptions={filterOptions} loading={state.loading} openOnFocus
      clearText={t('清除模型选择')} openText={t('展开模型列表')} closeText={t('收起模型列表')}
      loadingText={t('正在读取模型列表…')}
      noOptionsText={state.options.length ? t('没有匹配的模型，请换个关键词或手动输入模型 ID。') : t('先填写服务信息并读取模型列表；本地服务的 Key 可留空。')}
      onChange={(_, option) => window.dispatchEvent(new CustomEvent('reader:settings-model-change', { detail: option?.id || '' }))}
      slotProps={{ listbox: { sx: { maxHeight: 'min(320px, 45dvh)', '& .MuiAutocomplete-option': { minHeight: 44 } } }, paper: { sx: { border: 1, borderColor: 'divider' } } }}
      renderOption={({ key, ...props }, option) => <Box component="li" key={key} {...props} sx={{ overflowWrap: 'anywhere', display: 'block !important' }}>
        <Typography component="div" variant="body2">{option.label}</Typography>
        {option.label !== option.id && <Typography component="div" variant="caption" color="text.secondary">{option.id}</Typography>}
      </Box>}
      renderInput={params => <TextField {...params} size="small" placeholder={t('选择或搜索模型')} slotProps={{ ...params.slotProps, htmlInput: { ...params.slotProps.htmlInput, 'aria-describedby': 'model-list-help model-discovery-status' } }} />}
    />
  </>;
}
