import React, { useEffect } from 'react';
import { createRoot } from 'react-dom/client';
import '../../sidepanel.css';

/**
 * React owns the panel UI. The reading controller remains an imperative
 * boundary because it coordinates content-script messages and the MV3 worker;
 * it binds to this stable DOM contract after React commits the tree.
 */
function ReaderPanel() {
  useEffect(() => {
    void import('../../sidepanel.js');
  }, []);

  return (
    <main className="shell">
      <header className="masthead">
        <div className="wordmark"><span className="mark">R</span><span>READER / AI WORKBENCH</span></div>
        <nav className="utility" aria-label="阅读操作">
          <button id="open-history-header" className="header-action" title="查看过去的聊天会话和知识结论">聊天记录</button>
          <button id="settings-button" className="header-action" title="模型与数据设置">设置</button>
        </nav>
      </header>
      <div id="reader-status-strip" className="reader-status-strip" aria-label="当前运行状态">
        <span id="storage-status" className="mode-badge">独立模式</span>
        <span className="status"><i id="status-dot" className="status-dot" /><span id="status-text">未配置模型</span></span>
      </div>

      <section id="empty-view" className="empty">
        <div className="eyebrow">原网页阅读助手</div>
        <h1 id="empty-title">先连接一个模型，再开始阅读。</h1>
        <p id="empty-description">模型配置只保存在本地。配置完成后，点击扩展按钮启用当前网页。</p>
        <div className="actions"><button id="empty-settings" className="primary">配置模型</button><button id="empty-history" className="secondary">查看聊天记录</button></div>
      </section>

      <section id="page-view" className="hidden">
        <div className="hero">
          <div className="eyebrow">当前页面</div>
          <h1 id="page-title">打开一个网页后开始阅读</h1>
          <div id="page-source" className="source" />
          <div id="page-context-card" className="page-context-card">
            <div className="page-context-topline">
              <span id="page-context-status" className="page-context-status is-loading">正在读取正文</span>
              <span id="page-context-scope" className="page-context-scope">整页正文</span>
            </div>
            <div id="page-context-meta" className="page-context-meta">等待当前页面正文和章节信息。</div>
          </div>
          <div id="scope-notice" className="notice hidden" />
          <div className="actions">
            <button id="translate-all" className="primary">全文翻译</button>
            <label className="inline-control" htmlFor="translation-language"><span>译为</span><select id="translation-language" className="compact-select" defaultValue="zh-CN"><option value="zh-CN">简体中文</option><option value="zh-TW">繁体中文</option><option value="ja-JP">日本語</option><option value="en-US">English</option></select></label>
            <button id="pause-translation" className="secondary hidden">暂停</button>
            <button id="cancel-translation" className="danger hidden">取消任务</button>
            <button id="restore-page" className="secondary">恢复原文</button>
          </div>
          <div id="progress-area" className="progress hidden">
            <div className="progress-line"><span id="text-progress-label">正文翻译</span><span id="text-progress-value">0 / 0</span></div>
            <div className="track"><div id="text-progress-bar" className="bar" /></div>
            <div className="progress-line" style={{ marginTop: 8 }}><span id="image-progress-label">图片文字</span><span id="image-progress-value">未开始</span></div>
            <div className="track"><div id="image-progress-bar" className="bar image" /></div>
            <div id="translation-failures" className="translation-failures hidden" />
          </div>
          <div id="notice" className="notice hidden" />
        </div>

        <section id="quick-actions-section" className="quick-actions-panel">
          <div className="quick-actions-heading">
            <div>
              <div className="section-kicker">文章分析</div>
              <h2>从结构、实现和取舍继续阅读</h2>
            </div>
            <div className="quick-actions-heading-actions">
              <span id="quick-actions-scope" className="quick-actions-scope">整页正文</span>
              <button id="open-page-chat" className="secondary quick-chat-button" type="button">问整页</button>
            </div>
          </div>
          <div className="quick-actions-grid">
            <button id="quick-summary" className="quick-action quick-action-featured" type="button">
              <strong>全文总结</strong><span>问题、结论、机制和证据</span>
            </button>
            <button id="quick-map" className="quick-action" type="button">
              <strong>文章地图</strong><span>按章节梳理主线和依赖</span>
            </button>
            <button id="quick-mechanism" className="quick-action" type="button">
              <strong>关键机制</strong><span>组件、数据流和文中明确约束</span>
            </button>
            <button id="quick-tradeoffs" className="quick-action" type="button">
              <strong>风险与取舍</strong><span>前提、反例和待核对点</span>
            </button>
          </div>
        </section>

        <section id="selection-section" className="card paper hidden">
          <div className="card-title"><span>当前选段</span><span id="selection-scope">所在小节</span></div>
          <div id="selection-quote" className="quote" />
          <div className="selection-action-groups">
            <div className="selection-action-group">
              <div className="selection-action-label">针对这段</div>
              <div className="selection-actions">
                <button id="summarize-selection" className="secondary selection-action" type="button" title="用几个要点总结当前选段">
                  <strong>总结这段</strong><span>压缩成要点</span>
                </button>
                <button id="explain-selection" className="primary selection-action" type="button" title="解释当前选中的技术内容">
                  <strong>解释这段</strong><span>概念、机制和例子</span>
                </button>
                <button id="translate-selection" className="secondary selection-action" type="button" title="翻译当前选段并保留技术术语">
                  <strong>翻译这段</strong><span>保留 API / 代码标识</span>
                </button>
              </div>
            </div>
            <div className="selection-action-group">
              <div className="selection-action-label">聊天范围</div>
              <div className="selection-actions">
                <button id="ask-selection" className="secondary selection-action" type="button" title="只使用当前选段及所在小节回答问题">
                  <strong>问这段</strong><span>只用选段和所在小节</span>
                </button>
                <button id="ask-page" className="secondary selection-action" type="button" title="使用整页正文回答问题">
                  <strong>问整页</strong><span>切换到全文范围</span>
                </button>
                <button id="annotate-selection" className="secondary selection-action" type="button">
                  <strong>标注原文</strong><span>在原文留下位置和笔记</span>
                </button>
                <button id="save-selection" className="secondary selection-action" type="button">
                  <strong>保存摘录</strong><span>保存摘录、笔记和结论</span>
                </button>
              </div>
            </div>
          </div>
        </section>

        <section id="image-section" className="card hidden">
          <div className="card-title"><span>当前图示</span><span id="image-scope">视觉输入</span></div>
          <div id="image-preview" className="image-preview"><div id="image-preview-title" className="image-preview-title" /><div id="image-preview-meta" className="image-preview-meta" /></div>
          <div className="actions"><button id="explain-image" className="primary">解读图示</button><button id="ask-image" className="secondary">追问图示</button><button id="clear-image" className="secondary">清除</button></div>
        </section>

        <section id="discussion-section" className="discussion-panel hidden">
          <div className="section-label discussion-heading">
            <div>
              <h2>围绕原文聊天</h2>
              <div id="discussion-context-detail" className="discussion-context-detail" />
            </div>
            <div className="section-actions">
              <span id="discussion-context" className="discussion-context-badge">整页正文 · 提问</span>
              <button id="open-chat" className="text-button">聚焦输入</button>
              <button id="open-history-inline" className="text-button">聊天记录</button>
            </div>
          </div>
          <div id="discussion-source" className="discussion-source-card">
            <span className="discussion-source-mark">R</span>
            <div className="discussion-source-main">
              <strong id="discussion-source-title">当前页面</strong>
              <span id="discussion-source-url" />
            </div>
            <span id="discussion-source-scope" className="discussion-source-scope">整页正文</span>
          </div>
          <div className="chat-window">
            <div id="conversation-empty" className="conversation-empty">这是当前页面的聊天窗口。可以直接问整篇文章；选中原文后，会自动切换为选段上下文。</div>
            <div id="conversation-list" className="conversation-list" />
            <div id="answer-output" className="answer stream-answer hidden" />
            <div id="answer-structured" className="answer-structured hidden">
              <div id="answer-evidence" className="answer-part hidden"><div className="answer-label">原文证据</div><div id="answer-evidence-list" className="evidence-list" /></div>
              <div id="answer-background" className="answer-part hidden"><div className="answer-label">必要背景</div><div id="answer-background-text" /></div>
              <div id="answer-inference" className="answer-part hidden"><div className="answer-label">AI 推断</div><div id="answer-inference-text" /></div>
              <div id="answer-limitations" className="answer-part hidden"><div className="answer-label">适用条件与未知项</div><ul id="answer-limitations-list" /></div>
              <div id="answer-warnings" className="answer-warning hidden" />
            </div>
            <div id="answer-actions" className="answer-actions hidden">
              <button id="copy-answer" className="text-button" type="button" title="复制当前回答和原文证据">复制</button>
              <button id="save-answer" className="text-button" type="button" title="保存原文摘录、AI 结论和笔记">保存结论</button>
              <button id="return-answer" className="text-button" type="button" title="跳回当前回答使用的原文证据">回到原文</button>
              <button id="continue-answer" className="text-button" type="button" title="回到当前会话继续提问">继续追问</button>
            </div>
            <div id="discussion-followups" className="discussion-followups hidden">
              <div className="answer-label">继续追问</div>
              <div id="discussion-followup-list" className="discussion-followup-list" />
            </div>
          </div>
          <div className="chat-scope-bar" role="group" aria-label="回答范围">
            <span className="chat-scope-label">回答范围</span>
            <div className="chat-scope-options">
              <button id="scope-page" className="scope-option" type="button" aria-pressed="true">整页正文</button>
              <button id="scope-selection" className="scope-option hidden" type="button" aria-pressed="false">当前选段</button>
              <button id="scope-image" className="scope-option hidden" type="button" aria-pressed="false">当前图示</button>
            </div>
            <span id="scope-control-hint" className="scope-control-hint">会使用当前页面的正文</span>
          </div>
        </section>

        <section id="persistent-composer" className="chat-composer persistent-composer hidden" aria-label="围绕当前原文提问">
          <div className="composer-context-row">
            <span id="composer-scope-label" className="composer-scope-label">整页正文</span>
            <span id="composer-context-status" className="composer-context-status">正文状态：正在读取</span>
          </div>
          <textarea id="question-input" rows={3} placeholder="针对整篇文章提问，例如：作者的主要取舍是什么？" />
          <div className="chat-composer-footer">
            <span id="chat-composer-hint" className="chat-composer-hint">当前上下文会显示在上方</span>
            <button id="send-question" className="primary">发送问题</button>
          </div>
        </section>

        <section id="reading-section">
          <div className="section-label"><h2>我的阅读</h2><div className="section-actions"><button id="refresh-library" className="text-button">刷新</button></div></div>
          <div id="saved-insight-banner" className="saved-insight-banner hidden">
            <div>
              <strong id="saved-insight-title">已保存阅读结论</strong>
              <span id="saved-insight-detail">可以回到当前会话继续讨论。</span>
            </div>
            <button id="continue-saved-discussion" className="secondary" type="button">继续讨论</button>
          </div>
          <div className="sync-strip">
            <div>
              <strong id="platform-inline-status">成果保存在浏览器本地</strong>
              <span id="platform-inline-description">连接调研平台后，可把会话和确认过的结论写入研究库。</span>
            </div>
            <div className="sync-actions">
              <button id="sync-session" className="secondary hidden">同步会话</button>
              <button id="sync-selection" className="secondary hidden">同步结论</button>
            </div>
          </div>
          <div id="library-list" className="small" style={{ paddingTop: 10 }}>还没有本地保存的成果。</div>
        </section>
      </section>

      <section id="settings-view" className="setting-panel hidden">
        <div className="settings-view-head">
          <div><div className="eyebrow">设置</div><h2>模型与数据</h2></div>
          <button id="close-settings" className="secondary" type="button">返回阅读</button>
        </div>
        <div className="mode-switch" role="group" aria-label="Reader 运行方式">
          <button id="mode-local" className="mode-option" type="button" aria-pressed="true">
            <strong>独立模式</strong><span>自带模型，本地保存</span>
          </button>
          <button id="mode-platform" className="mode-option" type="button" aria-pressed="false">
            <strong>平台模式</strong><span>平台模型，数据库同步</span>
          </button>
        </div>

        <section id="platform-settings" className="settings-card">
          <div className="settings-card-heading">
            <div><div className="settings-kicker">Deep Research</div><h3>连接调研平台</h3></div>
            <span id="platform-status" className="connection-badge">未连接</span>
          </div>
          <p className="small">平台模式下，技术问答使用平台模型；阅读会话和确认保存的结论同步到 PostgreSQL。网页全文、图片字节和翻译缓存仍不会上传。</p>
          <p className="small">目标平台：<strong id="platform-target">techradar.top</strong></p>
          <div className="actions">
            <button id="connect-platform" className="primary">连接平台</button>
            <button id="disconnect-platform" className="danger hidden">断开连接</button>
            <button id="restore-session" className="secondary hidden">恢复云端会话</button>
          </div>
        </section>

        <section id="local-provider-settings" className="settings-card">
          <div className="settings-card-heading">
            <div><div className="settings-kicker">Standalone</div><h3>本地模型服务</h3></div>
          </div>
          <p className="small">独立模式的问答、全文翻译和图片理解直接调用这里配置的模型服务。支持 OpenAI-compatible Chat Completions 和 Anthropic Messages API；平台模式仍可用它处理图片翻译。</p>
          <div className="field"><label htmlFor="provider-kind">模型服务商</label><select id="provider-kind" defaultValue="openai"><option value="openai">OpenAI</option><option value="anthropic">Anthropic</option><option value="minimax">MiniMax</option><option value="deepseek">DeepSeek</option><option value="custom">其他 OpenAI-compatible 服务</option><option value="custom-anthropic">其他 Anthropic-compatible 服务</option></select></div>
          <div id="provider-custom-url-field" className="field hidden"><label htmlFor="provider-url">自定义接口地址</label><input id="provider-url" className="input" placeholder="https://你的服务/v1" /></div>
          <div id="provider-endpoint-hint" className="small provider-endpoint-hint" />
          <div className="field"><label htmlFor="provider-model">模型名称</label><input id="provider-model" className="input" placeholder="gpt-4o-mini" /></div>
          <div className="field"><label htmlFor="provider-key">API Key</label><input id="provider-key" className="input" type="password" autoComplete="off" placeholder="sk-..." /></div>
          <label className="check"><input id="request-provider-origin" type="checkbox" defaultChecked />保存时请求访问该模型服务域名，只在模型调用需要时使用。</label>
          <div className="actions"><button id="save-settings" className="primary">保存并测试连接</button></div>
        </section>
        <div id="settings-notice" className="notice hidden" />
        <div className="section-label"><h2>本地数据</h2></div>
        <div className="actions"><button id="export-data" className="secondary">导出阅读数据</button><button id="import-data" className="secondary">导入数据</button><button id="clear-cache" className="danger">清除翻译缓存</button><button id="clear-data" className="danger">清除本地数据</button></div>
        <p className="small" style={{ marginTop: 8 }}>卸载扩展前请先导出需要保留的阅读成果；卸载后浏览器本地数据不保证恢复。</p>
        <input id="import-file" type="file" accept="application/json" className="hidden" />
      </section>

      <section id="save-dialog" className="setting-panel hidden">
        <div className="eyebrow">保存阅读成果</div>
        <h2>留下以后能复用的结论</h2>
        <p className="small" style={{ marginTop: 8 }}>先确认摘录、笔记和 AI 结论，再保存到本地阅读库。原文不会自动全文保存。</p>
        <div className="card paper"><div className="card-title"><span>原文摘录</span><span id="save-source-title">当前页面</span></div><textarea id="save-quote" className="input" style={{ marginTop: 9, minHeight: 100 }} /></div>
        <div className="field"><label htmlFor="save-note">我的笔记</label><textarea id="save-note" placeholder="补充自己的判断、待验证问题或使用场景" /></div>
        <div className="field"><label htmlFor="save-ai-answer">要保存的 AI 结论</label><textarea id="save-ai-answer" placeholder="可以删掉不想长期保留的部分" /></div>
        <div className="field"><label htmlFor="save-tags">标签（用逗号分隔，最多 10 个）</label><input id="save-tags" className="input" placeholder="架构, 性能, 待验证" /></div>
        <div id="save-notice" className="notice hidden" />
        <div className="actions"><button id="confirm-save" className="primary">保存到本地阅读库</button><button id="cancel-save" className="secondary">取消</button></div>
      </section>

      <div className="footer">翻译、讨论和收藏默认留在你的浏览器。你可以随时导出或清除本地数据。</div>
    </main>
  );
}

createRoot(document.getElementById('root')!).render(<ReaderPanel />);
