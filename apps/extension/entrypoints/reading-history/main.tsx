import React, { useEffect } from 'react';
import { createRoot } from 'react-dom/client';
import '../../history.css';

function HistoryPage() {
  useEffect(() => {
    void import('../../history.js');
  }, []);

  const sidePanelSurface = new URLSearchParams(window.location.search).get('surface') === 'sidepanel';

  return (
    <main className={`history-shell${sidePanelSurface ? ' history-sidepanel' : ''}`}>
      <header className="history-header">
        <div className="history-brand"><span className="history-mark">R</span><span>DEEP RESEARCH READER</span></div>
        <div className="history-header-actions">
          <button id="close-history" className="history-quiet-button">返回阅读</button>
          <button id="export-history" className="history-secondary-button">导出当前列表</button>
        </div>
      </header>

      <div className="history-layout">
        <aside className="history-rail">
          <div className="history-kicker">LOCAL MEMORY</div>
          <h1>把读过的内容，<br /><em>重新找回来。</em></h1>
          <p className="history-intro">这里集中查看聊天会话和知识结论。独立模式读取浏览器本地数据；平台模式会同时读取已同步到调研平台的会话。</p>
          <nav className="history-tabs" aria-label="本地内容分类">
            <button className="history-tab active" data-history-tab="sessions"><span>聊天会话</span><strong id="session-count">0</strong></button>
            <button className="history-tab" data-history-tab="insights"><span>知识结论</span><strong id="insight-count">0</strong></button>
          </nav>
          <div className="history-rail-note"><span className="note-dot" />只保存你主动留下的阅读成果</div>
        </aside>

        <section className="history-content" aria-live="polite">
          <div className="history-toolbar">
            <div>
              <div className="history-section-kicker" id="history-section-kicker">READING SESSIONS</div>
              <h2 id="history-section-title">聊天会话</h2>
            </div>
            <label className="history-search"><span aria-hidden="true">⌕</span><input id="history-search-input" type="search" placeholder="搜索页面或历史问题" /><button id="clear-history-search" title="清除搜索" aria-label="清除搜索">×</button></label>
          </div>
          <div className="history-summary"><span id="history-summary-text">正在读取本地数据…</span><span id="history-filter-text" /></div>
          <div id="history-list" className="history-list" />
          <section id="history-detail" className="history-detail hidden" aria-live="polite">
            <div className="history-detail-header">
              <div>
                <div className="history-section-kicker">CONVERSATION</div>
                <h3 id="history-detail-title">聊天详情</h3>
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
              <div id="history-detail-evidence" className="history-detail-evidence" />
              <div id="history-detail-background" className="history-detail-part hidden"><strong>必要背景</strong><span /></div>
              <div id="history-detail-inference" className="history-detail-part hidden"><strong>AI 推断</strong><span /></div>
              <div id="history-detail-limitations" className="history-detail-part hidden"><strong>适用条件与未知项</strong><span /></div>
            </div>
          </section>
        </section>
      </div>
      <div id="history-toast" className="history-toast" role="status" />
    </main>
  );
}

createRoot(document.getElementById('history-root')!).render(<HistoryPage />);
