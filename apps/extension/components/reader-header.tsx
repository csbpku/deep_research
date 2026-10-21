import { t } from '../i18n.js';
import React from 'react';
import ButtonBase from '@mui/material/ButtonBase';
import SvgIcon from '@mui/material/SvgIcon';
import Typography from '@mui/material/Typography';
import '../reader-ui.css';

export function PanelIcon({ kind }: { kind: 'chat' | 'library' | 'history' | 'settings' }) {
  const paths = {
    chat: 'M4 4h16v12H9l-5 4V4',
    library: 'M6 3h12v18l-6-4-6 4V3',
    history: 'M3 11a9 9 0 1 1 2.6 7 M3 4v7h7 M12 7v5l3 2',
    settings: 'M4 7h16 M4 17h16 M8 4v6 M16 14v6',
  };
  return <SvgIcon viewBox="0 0 24 24" sx={{ fontSize: 18, fill: 'none', stroke: 'currentColor', strokeWidth: 1.7, strokeLinecap: 'round', strokeLinejoin: 'round' }}><path d={paths[kind]} /></SvgIcon>;
}

export function ReaderHeader({ history = false, children }: { history?: boolean; children?: React.ReactNode }) {
  return <header className="masthead">
    <div className="reader-identity">
    <div className="wordmark"><span className="mark">R</span><Typography component="span" variant="subtitle2">Reader</Typography></div>
      {children}
    </div>
    <nav className="workspace-nav" aria-label={t("工作台导航")}>
      <ButtonBase id={history ? 'close-history' : 'nav-chat'} data-reader-control="navigation" className={`workspace-nav-item${history ? '' : ' active'}`} type="button" aria-label={t("聊天")} title={t("聊天")} aria-pressed={!history}><PanelIcon kind="chat" /><span>{t("聊天")}</span></ButtonBase>
      <ButtonBase id={history ? 'history-library' : 'nav-library'} data-reader-control="navigation" className="workspace-nav-item" type="button" aria-label={t("收藏")} title={t("收藏")} aria-pressed="false"><PanelIcon kind="library" /><span>{t("收藏")}</span></ButtonBase>
      <ButtonBase id={history ? 'history-current' : 'open-history-header'} data-reader-control="navigation" className={`workspace-nav-item${history ? ' active' : ''}`} type="button" aria-label={t("历史")} title={t("历史")} aria-current={history ? 'page' : undefined}><PanelIcon kind="history" /><span>{t("历史")}</span></ButtonBase>
      <ButtonBase id={history ? 'history-settings' : 'settings-button'} data-reader-control="navigation" className="workspace-nav-item nav-settings" type="button" aria-label={t("设置")} title={t("模型与数据设置")}><PanelIcon kind="settings" /><span>{t("设置")}</span></ButtonBase>
    </nav>
  </header>;
}

export function ComposerIcon({ kind, size = 17 }: { kind: 'expand' | 'summary' | 'translate' | 'plus' | 'send' | 'stop' | 'eye' | 'chevron-down' | 'arrow-forward' | 'close' | 'check' | 'copy' | 'bookmark'; size?: number }) {
  const paths = {
    expand: 'M8 3H3v5 M16 21h5v-5 M3 3l6 6 M21 21l-6-6',
    summary: 'M5 6h14 M5 12h14 M5 18h9',
    translate: 'M3 5h12 M9 3v2 M5 5c1 6 4 9 9 11 M13 5c-1 5-5 9-10 11 M14 21l4-11 4 11 M16 17h4',
    plus: 'M12 5v14 M5 12h14',
    send: 'M12 19V5 M5 12l7-7 7 7',
    stop: 'M6 6h12v12H6z',
    eye: 'M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12 M9 12a3 3 0 1 0 6 0a3 3 0 1 0-6 0',
    'chevron-down': 'M6 9l6 6 6-6',
    'arrow-forward': 'M4 12h16 M14 6l6 6-6 6',
    close: 'M6 6l12 12 M6 18L18 6',
    check: 'M5 12l4 4L19 6',
    copy: 'M9 8h11v13H9z M15 8V3H4v13h5',
    bookmark: 'M6 3h12v18l-6-4-6 4V3',
  };
  return <SvgIcon viewBox="0 0 24 24" sx={{ fontSize: size, fill: 'none', stroke: 'currentColor', strokeWidth: 1.7, strokeLinecap: 'round', strokeLinejoin: 'round' }}><path d={paths[kind]} /></SvgIcon>;
}
