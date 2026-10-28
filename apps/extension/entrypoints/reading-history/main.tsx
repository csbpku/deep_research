import { t, initializeLocale } from '../../i18n.js';
import Typography from '@mui/material/Typography';
import React, { useEffect } from 'react';
import { createRoot } from 'react-dom/client';
import Box from '@mui/material/Box';
import Paper from '@mui/material/Paper';
import '../../history.css';
import { ComposerIcon, ReaderHeader } from '../../components/reader-header';
import { ReaderButton, ReaderTextField, ReaderDisclosure } from '../../components/reader-controls';
import { ReaderThemeProvider } from '../../components/reader-theme';

function HistoryPage() {
  useEffect(() => {
    void import('../../history.js');
  }, []);

  const sidePanelSurface = new URLSearchParams(window.location.search).get('surface') === 'sidepanel';

  return (
    <Box component="main" className={`history-shell${sidePanelSurface ? ' history-sidepanel' : ''}`}>
      <ReaderHeader history />

      <div className="history-layout">
        <aside className="history-rail">
          <div className="history-title-row"><Typography component="h1" variant="h1">{t("历史")}</Typography><ReaderButton id="export-history" variant="text">{t("导出列表")}</ReaderButton></div>
          <nav id="history-tabs" className="history-tabs" aria-label={t("本地内容分类")} aria-busy="true">
            <ReaderButton control="scope" className="history-tab active" data-history-tab="sessions" aria-pressed="true" variant="text"><span>{t("聊天会话")}</span><strong id="session-count">0</strong></ReaderButton>
            <ReaderButton control="scope" className="history-tab" data-history-tab="insights" aria-pressed="false" variant="text"><span>{t("知识结论")}</span><strong id="insight-count">0</strong></ReaderButton>
          </nav>

        </aside>

        <section className="history-content">
          <div className="history-toolbar">
            <div>
              <div className="history-section-kicker" id="history-section-kicker">{t("聊天会话")}</div>
              <Typography component="h2" variant="h2" id="history-section-title">{t("聊天会话")}</Typography>
            </div>
            <div className="history-search"><ReaderTextField id="history-search-input" type="search" placeholder={t("页面标题、原文或问题")} slotProps={{ htmlInput: { 'aria-label': t("搜索页面或历史问题") } }} /><ReaderButton id="clear-history-search" control="icon" title={t("清除搜索")} aria-label={t("清除搜索")}><ComposerIcon kind="close" size={18} /></ReaderButton></div>
          </div>
          <div className="history-summary" role="status" aria-live="polite"><span id="history-summary-text">{t("正在读取本地数据…")}</span><span id="history-filter-text" /></div>
          <div id="history-list" className="history-list" />
          <section id="history-detail" className="history-detail hidden" role="region" aria-label={t("聊天详情")}>
            <div className="history-detail-header">
              <div>
                <div className="history-section-kicker">{t("聊天详情")}</div>
                <Typography component="h3" variant="h3" id="history-detail-title" tabIndex={-1}>{t("聊天详情")}</Typography>
                <div id="history-detail-source" className="history-card-source" />
              </div>
              <div className="history-detail-actions">
                <ReaderButton id="continue-history-detail" variant="contained">{t("继续聊天")}</ReaderButton>
                <ReaderButton id="close-history-detail" variant="outlined">{t("返回列表")}</ReaderButton>
              </div>
            </div>
            <div id="history-detail-selection" className="history-detail-selection hidden" />
            <div className="history-detail-meta"><span id="history-detail-scope" /><span id="history-detail-time" /></div>
            <div id="history-detail-messages" className="history-detail-messages" />
            <div id="history-detail-structured" className="history-detail-structured hidden">
              <div className="history-detail-label">{t("最新回答的证据与边界")}</div>
              <div id="history-detail-evidence-section" className="response-section hidden" data-answer-section="evidence"><div className="response-section-label">{t("原文证据")}</div><div id="history-detail-evidence" className="history-detail-evidence" /></div>
              <ReaderDisclosure id="history-detail-more" className="response-more hidden" label={<>{t("补充说明")}<span id="history-detail-more-summary" className="response-more-summary" /></>}>
              <div id="history-detail-background" className="history-detail-part response-section hidden" data-answer-section="background"><strong className="response-section-label">{t("必要背景")}</strong><span /></div>
              <div id="history-detail-inference" className="history-detail-part response-section hidden" data-answer-section="inference"><strong className="response-section-label">{t("AI 推断")}</strong><span /></div>
              <div id="history-detail-limitations" className="history-detail-part response-section hidden" data-answer-section="limitations"><strong className="response-section-label">{t("适用条件与未知项")}</strong><span /></div>
              </ReaderDisclosure>
            </div>
          </section>
        </section>
      </div>
      <div id="history-toast" className="history-toast" role="status" />
    </Box>
  );
}

void initializeLocale().then(() => createRoot(document.getElementById('history-root')!).render(<ReaderThemeProvider><HistoryPage /></ReaderThemeProvider>));
