import { t } from '../i18n.js';
import Typography from '@mui/material/Typography';
import React from 'react';
import { PROVIDER_CATALOG, PROVIDER_GROUPS } from '../provider-catalog.js';
import { ReaderButton, ReaderTextField } from './reader-controls';
import Paper from '@mui/material/Paper';
import { ComposerIcon } from './reader-header';

export function ProviderSelector() {
  return <div className="field">
    <label htmlFor="provider-picker-trigger">{t("服务商")}</label>
    <div id="provider-picker" className="provider-picker">
      <select id="provider-kind" className="hidden" aria-hidden="true" tabIndex={-1} defaultValue="openai">
        {PROVIDER_GROUPS.map(group => <optgroup key={group.id} label={t(group.label)}>
          {PROVIDER_CATALOG.filter(item => item.group === group.id).map(item => <option key={item.id} value={item.id}>{t(item.label)} · {t(item.subtitle)}</option>)}
        </optgroup>)}
      </select>
      <ReaderButton variant="outlined" control="provider" id="provider-picker-trigger" className="provider-picker-trigger" type="button" role="combobox" aria-label={t("服务商")} aria-controls="provider-picker-menu" aria-haspopup="dialog" aria-expanded="false">
        <img id="provider-picker-icon" src="providers/openai.svg" alt="" width="30" height="30" />
        <span className="provider-picker-selected"><strong id="provider-picker-label">OpenAI</strong><span id="provider-picker-subtitle">GPT</span></span>
        <ComposerIcon kind="chevron-down" />
      </ReaderButton>
      <Paper component="section" elevation={3} id="provider-picker-menu" className="provider-picker-menu hidden" role="dialog" aria-label={t("选择模型服务商")}>
        <div className="provider-picker-search-row">
          <ReaderTextField id="provider-picker-search" type="search" placeholder={t("搜索服务商")} aria-label={t("搜索服务商")} autoComplete="off"  />
          <ReaderButton control="icon" id="provider-picker-close" className="provider-picker-close" type="button" title={t("关闭服务商选择")} aria-label={t("关闭服务商选择")}><ComposerIcon kind="close" /></ReaderButton>
        </div>
        <div id="provider-picker-options" className="provider-picker-options" role="listbox" aria-label={t("可选服务商")}>
          {PROVIDER_GROUPS.map(group => <section key={group.id} data-provider-group={group.id} className="provider-picker-group" role="group" aria-label={t(group.label)}>
            <Typography component="h4" variant="h3">{t(group.label)}</Typography>
            <div className="provider-picker-grid">
              {PROVIDER_CATALOG.filter(item => item.group === group.id).map(item => <ReaderButton control="provider" key={item.id} className="provider-picker-option" type="button" role="option" aria-selected={item.id === 'openai'} data-provider-id={item.id} title={`${t(item.label)} · ${t(item.subtitle)}`}>
                <img className={item.id === 'moonshot' ? 'provider-logo-dark' : undefined} src={`providers/${item.icon}`} alt="" width="26" height="26" loading="lazy" />
                <span><strong>{t(item.label)}</strong><small>{t(item.subtitle)}</small></span>
                <span className="provider-picker-check" aria-hidden="true"><ComposerIcon kind="check" /></span>
              </ReaderButton>)}
            </div>
          </section>)}
          <div id="provider-picker-empty" className="provider-picker-empty hidden"><p>{t("没有匹配的服务商")}</p><ReaderButton id="provider-picker-custom" type="button">{t("使用自定义接口")}</ReaderButton></div>
        </div>
      </Paper>
    </div>
  </div>;
}
