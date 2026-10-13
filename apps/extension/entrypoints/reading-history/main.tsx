import React, { useEffect } from 'react';
import { createRoot } from 'react-dom/client';
import '../../history.css';
import { ReaderHeader } from '../../components/reader-header';

function HistoryPage() {
  useEffect(() => {
    void import('../../history.js');
  }, []);

  const sidePanelSurface = new URLSearchParams(window.location.search).get('surface') === 'sidepanel';

  return (
    <main className={`history-shell${sidePanelSurface ? ' history-sidepanel' : ''}`}>
      <ReaderHeader history />

      <div className="history-layout">
        <aside className="history-rail">
          <div className="history-title-row"><h1>历史</h1><button id="export-history" className="history-quiet-button">导出列表</button></div>
          <nav id="history-tabs" className="history-tabs" aria-label="本地内容分类" aria-busy="true">
            <button className="history-tab active" data-history-tab="sessions" aria-pressed="true" disabled><span>聊天会话</span><strong id="session-count">0</strong></button>
            <button className="history-tab" data-history-tab="insights" aria-pressed="false" disabled><span>知识结论</span><strong id="insight-count">0</strong></button>
          </nav>

        </aside>

        <section className="history-content">
          <div className="history-toolbar">
            <div>
              <div className="history-section-kicker" id="history-section-kicker">聊天会话</div>
              <h2 id="history-section-title">聊天会话</h2>
            </div>
            <label className="history-search"><svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" aria-hidden="true"><circle cx="10.5" cy="10.5" r="6.5" /><path d="m16 16 5 5" /></svg><span className="history-search-label">搜索</span><input id="history-search-input" type="search" aria-label="搜索页面或历史问题" placeholder="页面标题、原文或问题" /><button id="clear-history-search" title="清除搜索" aria-label="清除搜索">×</button></label>
          </div>
          <div className="history-summary" role="status" aria-live="polite"><span id="history-summary-text">正在读取本地数据…</span><span id="history-filter-text" /></div>
          <div id="history-list" className="history-list" />
          <section id="history-detail" className="history-detail hidden" role="region" aria-label="聊天详情">
            <div className="history-detail-header">
              <div>
                <div className="history-section-kicker">聊天详情</div>
                <h3 id="history-detail-title" tabIndex={-1}>聊天详情</h3>
                <div id="history-detail-source" className="history-card-source" />
              </div>
              <div className="history-detail-actions">
                <button id="continue-history-detail" className="history-primary-button">继续聊天</button>
                <button id="close-history-detail" className="history-secondary-button">返回列表</button>
              </div>
            </div>
            <div id="history-detail-selection" className="history-detail-selection hidden" />
            <div className="history-detail-meta"><span id="history-detail-scope" /><span id="history-detail-time" /></div>
            <div id="history-detail-messages" className="history-detail-messages" />
            <div id="history-detail-structured" className="history-detail-structured hidden">
              <div className="history-detail-label">最新回答的证据与边界</div>
              <div id="history-detail-evidence-section" className="response-section hidden" data-answer-section="evidence"><div className="response-section-label">原文证据</div><div id="history-detail-evidence" className="history-detail-evidence" /></div>
              <details id="history-detail-more" className="response-more hidden"><summary>补充说明<span id="history-detail-more-summary" className="response-more-summary" /></summary>
              <div id="history-detail-background" className="history-detail-part response-section hidden" data-answer-section="background"><strong className="response-section-label">必要背景</strong><span /></div>
              <div id="history-detail-inference" className="history-detail-part response-section hidden" data-answer-section="inference"><strong className="response-section-label">AI 推断</strong><span /></div>
              <div id="history-detail-limitations" className="history-detail-part response-section hidden" data-answer-section="limitations"><strong className="response-section-label">适用条件与未知项</strong><span /></div>
              </details>
            </div>
          </section>
        </section>
      </div>
      <div id="history-toast" className="history-toast" role="status" />
    </main>
  );
}

createRoot(document.getElementById('history-root')!).render(<HistoryPage />);
