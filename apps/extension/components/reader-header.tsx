import React from 'react';
import '../reader-ui.css';

export function PanelIcon({ kind }: { kind: 'chat' | 'library' | 'history' | 'settings' }) {
  const paths = {
    chat: 'M4 4h16v12H9l-5 4V4',
    library: 'M6 3h12v18l-6-4-6 4V3',
    history: 'M3 11a9 9 0 1 1 2.6 7 M3 4v7h7 M12 7v5l3 2',
    settings: 'M4 7h16 M4 17h16 M8 4v6 M16 14v6',
  };
  return <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={paths[kind]} /></svg>;
}

export function ReaderHeader({ history = false, children }: { history?: boolean; children?: React.ReactNode }) {
  return <header className="masthead">
    <div className="reader-identity">
      <div className="wordmark"><span className="mark">R</span><span>Reader</span></div>
      {children}
    </div>
    <nav className="workspace-nav" aria-label="工作台导航">
      <button id={history ? 'close-history' : 'nav-chat'} className={`workspace-nav-item${history ? '' : ' active'}`} type="button" aria-label="聊天" title="聊天" aria-pressed={!history}><PanelIcon kind="chat" /><span>聊天</span></button>
      <button id={history ? 'history-library' : 'nav-library'} className="workspace-nav-item" type="button" aria-label="收藏" title="收藏" aria-pressed="false"><PanelIcon kind="library" /><span>收藏</span></button>
      <button id={history ? 'history-current' : 'open-history-header'} className={`workspace-nav-item${history ? ' active' : ''}`} type="button" aria-label="历史" title="历史" aria-current={history ? 'page' : undefined}><PanelIcon kind="history" /><span>历史</span></button>
      <button id={history ? 'history-settings' : 'settings-button'} className="workspace-nav-item nav-settings" type="button" aria-label="设置" title="模型与数据设置"><PanelIcon kind="settings" /><span>设置</span></button>
    </nav>
  </header>;
}

export function ComposerIcon({ kind }: { kind: 'summary' | 'translate' | 'plus' | 'send' }) {
  const paths = {
    summary: 'M5 6h14 M5 12h14 M5 18h9',
    translate: 'M3 5h12 M9 3v2 M5 5c1 6 4 9 9 11 M13 5c-1 5-5 9-10 11 M14 21l4-11 4 11 M16 17h4',
    plus: 'M12 5v14 M5 12h14',
    send: 'M12 19V5 M5 12l7-7 7 7',
  };
  return <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={paths[kind]} /></svg>;
}
