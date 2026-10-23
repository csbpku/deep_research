import { space } from "@deep-research/design-system";
import { t, initializeLocale } from '../../i18n.js';
import Typography from '@mui/material/Typography';
import React, { useEffect } from 'react';
import { createRoot } from 'react-dom/client';
import Box from '@mui/material/Box';
import Paper from '@mui/material/Paper';
import Alert from '@mui/material/Alert';
import CircularProgress from '@mui/material/CircularProgress';
import InputBase from '@mui/material/InputBase';
import '../../sidepanel.css';
import { ReaderHeader, ComposerIcon } from '../../components/reader-header';
import { ReaderButton, ReaderTextField, ReaderSelect, ReaderDisclosure } from '../../components/reader-controls';
import { ReaderThemeProvider } from '../../components/reader-theme';
import { TranslationLanguagePicker } from '../../components/translation-language-picker';
import { ProviderSelector } from '../../components/provider-selector';

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
    <Box component="main" className="shell" data-workspace-view="chat">
      <ReaderHeader>
        <div id="reader-status-strip" className="reader-status-strip" role="status" aria-live="polite" aria-label={t("当前运行状态")}>
          <span id="storage-status" className="mode-badge">{t("独立模式")}</span>
          <span className="status"><i id="status-dot" className="status-dot" aria-hidden="true" /><span id="status-text">{t("未配置模型")}</span></span>
        </div>
      </ReaderHeader>

      <section id="empty-view" className="empty">
        <div className="eyebrow">{t("原网页阅读助手")}</div>
        <Typography component="h1" variant="h1" id="empty-title">{t("先准备阅读模型。")}</Typography>
        <p id="empty-description">{t("独立模式配置自己的模型；平台模式登录调研平台后直接使用平台 AI Engine。")}</p>
        <div className="actions"><ReaderButton id="empty-settings" variant="contained">{t("配置模型")}</ReaderButton><ReaderButton id="empty-history" variant="outlined">{t("查看聊天记录")}</ReaderButton></div>
      </section>

      <section id="page-view" className="reader-page-view hidden">
        <div id="page-overview-scroll" className="page-overview-scroll">
        <div className="hero">
          <div className="eyebrow">{t("当前页面")}</div>
          <Typography component="h1" variant="h1" id="page-title">{t("打开一个网页后开始阅读")}</Typography>
          <div id="page-source" className="source" />
          <Paper component="div" id="page-context-card" className="page-context-card" variant="outlined" elevation={0}>
            <div className="page-context-topline">
              <span id="page-context-status" className="page-context-status is-loading" role="status" aria-live="polite">{t("正在读取正文")}</span>
              <span id="page-context-scope" className="page-context-scope">{t("整页正文")}</span>
            </div>
            <div id="page-context-meta" className="page-context-meta">{t("等待当前页面正文和章节信息。")}</div>
          </Paper>
          <div id="ai-availability-banner" className="ai-availability-banner hidden">
            <span id="ai-availability-message" role="status" aria-live="polite" />
            <ReaderButton id="ai-availability-action" type="button" variant="text">{t("配置模型")}</ReaderButton>
          </div>
        </div>


        <section id="reading-section">
          <div className="section-label"><Typography component="h2" variant="h3">{t("收藏与标注")}</Typography><div className="section-actions"><ReaderButton id="refresh-library" variant="text">{t("刷新")}</ReaderButton></div></div>
          <p className="library-description">{t("只展示你确认保存的摘录、结论和标注。")}</p>
          <Paper component="div" variant="outlined" id="saved-insight-banner" className="saved-insight-banner hidden">
            <div>
              <strong id="saved-insight-title">{t("已保存阅读结论")}</strong>
              <span id="saved-insight-detail">{t("可以回到当前会话继续讨论。")}</span>
            </div>
            <ReaderButton id="continue-saved-discussion" type="button" variant="outlined">{t("继续讨论")}</ReaderButton>
          </Paper>
          <div className="sync-strip">
            <div>
              <strong id="platform-inline-status">{t("成果保存在浏览器本地")}</strong>
              <span id="platform-inline-description">{t("连接调研平台后，可把会话和确认过的结论写入研究库。")}</span>
            </div>
            <div className="sync-actions">
              <ReaderButton id="sync-session" className="hidden" variant="outlined">{t("同步会话")}</ReaderButton>
            </div>
          </div>
          <div id="library-list" className="small" style={{ paddingTop: 10 }}>{t("还没有本地保存的成果。")}</div>
        </section>
        </div>

        <div className="page-notice-container">
          <Alert id="notice" className="notice page-notice hidden" role="status" aria-live="polite"  icon={false} severity="info" />
          <ReaderButton id="sync-selection" className="notice-retry hidden" type="button" variant="outlined">{t("重试同步")}</ReaderButton>
          <ReaderButton id="dismiss-notice" className="dismiss-notice" type="button" aria-label={t("收起提示")} title={t("收起提示")} variant="text" control="icon"><ComposerIcon kind="close" /></ReaderButton>
        </div>
        <section id="discussion-section" className="discussion-panel hidden">
          <div className="section-label discussion-heading">
            <div>
              <Typography component="h2" variant="h2">{t("聊天")}</Typography>
              <div id="discussion-context-detail" className="discussion-context-detail" />
            </div>
            <div className="section-actions">
              <span id="discussion-context" className="discussion-context-badge">{t("整页正文 · 提问")}</span>
              <ReaderButton id="expand-chat" className="hidden discussion-action" type="button" aria-pressed="false" aria-controls="discussion-section" variant="outlined">{t("放大聊天")}</ReaderButton>
              <ReaderButton id="open-history-inline" variant="text">{t("聊天记录")}</ReaderButton>
            </div>
          </div>
          <div id="discussion-source" className="discussion-source-card">

            <div className="discussion-source-main">
              <strong id="discussion-source-title">{t("当前页面")}</strong>
              <span id="discussion-source-url" />
            </div>
            <ReaderButton id="chat-to-reading" className="source-link" type="button" title={t("在网页中定位本次回答依据")} variant="text">{t("原文 ↗")}</ReaderButton>
          </div>

          <div className="chat-window">
            {/* Page context sits above the conversation column. It is not part
                of the transcript: keeping it in the scroll area squeezed the
                empty state out of view and broke the centred first-run
                layout. */}
            <Box component="section" id="page-knowledge" className="hidden" aria-labelledby="page-knowledge-title" sx={{ mb: space.md, flex: 'none' }}>
              <ReaderDisclosure id="page-knowledge-disclosure" label={t("本页已保存")}>
                <Typography id="page-knowledge-title" component="h3" variant="subtitle2" color="text.secondary" sx={{ mb: space.sm }}>{t("摘录与结论")}</Typography>
                <div id="page-knowledge-list" />
              </ReaderDisclosure>
            </Box>
            <ReaderDisclosure id="scope-details" className="source-scope-details hidden" label={t("正文范围说明")}><Alert id="scope-notice" className="notice hidden" role="status" aria-live="polite" icon={false} severity="info" /></ReaderDisclosure>
            <div id="chat-transcript" className="chat-transcript">
              <div id="conversation-empty" className="conversation-empty"><Typography component="h2" variant="h2">{t("一起读懂这篇文章")}</Typography><p>{t("直接提问，或先总结、翻译。选中原文后，可以只聊那一段。")}</p><div className="conversation-starters"><ReaderButton id="starter-summary" type="button" variant="outlined">{t("文章讲了什么？")}</ReaderButton></div></div>
              <div id="conversation-list" className="conversation-list" />
              <div id="pending-turn" className="pending-turn hidden" aria-busy="false">
                <article className="conversation-message user"><div id="pending-question" className="conversation-message-body" /></article>
                <article className="conversation-message assistant">
                  <div className="conversation-message-header">Reader</div>
                  <div id="answer-progress" className="answer-progress" role="status" aria-live="polite" aria-atomic="true"><CircularProgress size={16} aria-hidden="true" /><span id="answer-progress-text">{t("正在读取原文…")}</span></div>
                  <div id="answer-output" className="conversation-message-body stream-answer hidden" aria-live="off" />
                </article>
              </div>
              <div id="answer-actions" className="answer-actions hidden" role="group" aria-label={t("回答操作")}>
                <ReaderButton id="copy-answer" className="answer-action answer-copy" variant="outlined" type="button" startIcon={<ComposerIcon kind="copy" />} title={t("复制当前回答和原文证据")}>{t("复制")}</ReaderButton>
                <ReaderButton id="save-answer" className="answer-action answer-save" type="button" startIcon={<ComposerIcon kind="bookmark" />} title={t("保存原文摘录、AI 结论和笔记")} variant="text" control="tonal">{t("保存结论")}</ReaderButton>
              </div>
              <div id="answer-structured" className="answer-structured hidden">
                <div id="answer-evidence" className="answer-part response-section hidden" data-answer-section="evidence"><div className="response-section-label">{t("原文证据")}</div><div id="answer-evidence-list" className="evidence-list" /></div>
                <ReaderDisclosure id="answer-more" className="response-more hidden" label={<>{t("补充说明")}<span id="answer-more-summary" className="response-more-summary" /></>}>
                <div id="answer-background" className="answer-part response-section hidden" data-answer-section="background"><div className="response-section-label">{t("必要背景")}</div><div id="answer-background-text" /></div>
                <div id="answer-inference" className="answer-part response-section hidden" data-answer-section="inference"><div className="response-section-label">{t("AI 推断")}</div><div id="answer-inference-text" /></div>
                <div id="answer-limitations" className="answer-part response-section hidden" data-answer-section="limitations"><div className="response-section-label">{t("适用条件与未知项")}</div><ul id="answer-limitations-list" /></div>
                </ReaderDisclosure>
                <Alert id="answer-warnings" className="answer-warning hidden"  icon={false} severity="info" />
              </div>
              <Paper component="section" variant="outlined" id="discussion-followups" className="discussion-followups hidden" aria-labelledby="discussion-followups-title" sx={{ mt: space.section, px: space.sm, py: space.md }}>
                <Typography id="discussion-followups-title" component="h3" variant="subtitle2" color="text.secondary" sx={{ px: space.sm, mb: space.sm }}>{t("继续追问")}</Typography>
                <div id="discussion-followup-list" className="discussion-followup-list" />
              </Paper>
              <Paper component="section" variant="outlined" id="translation-summary" className="translation-task hidden" aria-label={t("网页翻译")}>
                <div className="translation-task-heading"><span id="translation-summary-text" role="status" aria-live="polite" /><div className="translation-task-actions"><ReaderButton id="pause-translation" className="hidden" type="button" variant="text">{t("暂停")}</ReaderButton><ReaderButton id="restore-page" className="hidden" type="button" title={t("移除本页全部译文；之后可以重新翻译")} variant="text">{t("恢复原文")}</ReaderButton><ReaderButton id="cancel-translation" className="hidden" type="button" variant="text">{t("取消")}</ReaderButton></div></div>
                <ReaderDisclosure id="translation-details" label={<>{t("翻译进度与重试")}</>}>
                  <div id="progress-area" className="progress hidden" role="group" aria-label={t("全文翻译进度")}>
                    <div className="progress-line"><span id="text-progress-label">{t("正文翻译")}</span><span id="text-progress-value">0 / 0</span></div>
                    <div id="text-progress-track" className="track" role="progressbar" aria-labelledby="text-progress-label" aria-valuemin={0} aria-valuemax={100} aria-valuenow={0} aria-valuetext={t("尚未开始")}><div id="text-progress-bar" className="bar" /></div>
                    <div className="progress-line"><span id="image-progress-label">{t("图片文字")}</span><span id="image-progress-value">{t("未开始")}</span></div>
                    <div id="image-progress-track" className="track" role="progressbar" aria-labelledby="image-progress-label" aria-valuemin={0} aria-valuemax={100} aria-valuenow={0} aria-valuetext={t("尚未开始")}><div id="image-progress-bar" className="bar image" /></div>
                    <div id="translation-failures" className="translation-failures hidden" />
                  </div>
                  <p className="tool-help">{t("鼠标停在段落上，按 Alt+Shift+O 切换该段原文与译文。")}</p>
                </ReaderDisclosure>
              </Paper>
            </div>
            <Paper component="div" id="persistent-composer" className="chat-composer persistent-composer hidden" aria-label={t("围绕当前原文提问")} variant="outlined" elevation={0} >
              <div id="composer-resize" className="composer-resize" role="separator" tabIndex={0} aria-label={t("调整输入区高度")} aria-orientation="horizontal" aria-valuemin={60} aria-valuemax={240} aria-valuenow={60} title={t("上下拖动调整输入区；方向键也可调整")}><span /></div>
              <div className="composer-context-row">
                <ReaderButton id="composer-size-toggle" type="button" control="icon" variant="text" aria-label={t("展开输入框")} aria-expanded="false" title={t("展开或收起输入框")}><ComposerIcon kind="expand" size={20} /></ReaderButton>
            <div id="discussion-scope-options" className="discussion-scope-options" role="group" aria-label={t("回答依据")}>
              <span className="discussion-scope-label">{t("基于")}</span>
              <ReaderButton id="scope-page" className="scope-option" type="button" variant="text" control="scope">{t("整篇")}</ReaderButton>
              <ReaderButton id="scope-selection" className="scope-option hidden" type="button" variant="text" control="scope">{t("选段")}</ReaderButton>
              <ReaderButton id="scope-image" className="scope-option hidden" type="button" variant="text" control="scope">{t("图示")}</ReaderButton>
            </div>
                <span id="composer-scope-label" className="composer-scope-label">{t("整页正文")}</span><ReaderButton id="composer-model" className="composer-model" control="model" type="button" aria-expanded="false" aria-controls="composer-model-menu" title={t("模型与连接设置")} variant="text" endIcon={<ComposerIcon kind="chevron-down" size={20} />}><span id="composer-model-label">{t("配置模型")}</span></ReaderButton>
                <span id="composer-context-status" className="composer-context-status">{t("正文状态：正在读取")}</span><span id="chat-scope-description" className="hidden">{t("基于整篇文章")}</span>
              </div>
              <Paper component="div" variant="outlined" id="composer-model-menu" className="composer-model-menu hidden" role="dialog" aria-label={t("切换模型")}><label htmlFor="composer-model-search">{t("选择模型")}</label><ReaderTextField id="composer-model-search" type="search" placeholder={t("搜索模型…")} autoComplete="off"  /><div id="composer-model-options" className="composer-model-options" role="listbox" aria-label={t("可用模型")} /><div id="composer-model-status" className="small" role="status" /><div className="composer-model-actions"><ReaderButton id="composer-model-refresh" type="button" variant="text">{t("刷新列表")}</ReaderButton><ReaderButton id="composer-model-settings" type="button" variant="text">{t("连接设置")}</ReaderButton></div></Paper>
              <Paper component="div" variant="outlined" id="chat-selection-card" className="chat-selection-card hidden" aria-label={t("当前选中的原文")}>
                <div className="selection-preview-heading"><ReaderButton id="clear-chat-selection" type="button" aria-label={t("清除选段，基于整篇")} title={t("清除选段，基于整篇")} variant="text">×</ReaderButton></div>
                <blockquote id="chat-selection-quote" />
                <div id="selection-section" className="selection-preview-actions">
                  <ReaderButton id="copy-chat-selection" type="button" variant="text">{t("复制选段")}</ReaderButton>
                  <ReaderButton id="annotate-selection" type="button" title={t("在原网页高亮并添加笔记")} variant="text">{t("标注")}</ReaderButton>
                  <ReaderButton id="save-selection" type="button" title={t("将选段存入阅读库")} variant="text">{t("保存摘录")}</ReaderButton>
                  <ReaderButton id="toggle-chat-selection" type="button" aria-expanded="false" aria-controls="chat-selection-quote" variant="text">{t("展开")}</ReaderButton>
                </div>
              </Paper>
              <Paper component="div" variant="outlined" id="image-section" className="image-context-card hidden" aria-label={t("当前图示")}>
                <div id="image-preview" className="image-preview"><img id="image-preview-thumbnail" className="hidden" alt={t("当前图示预览")} width={64} height={48} referrerPolicy="no-referrer" crossOrigin="anonymous" /><div id="image-preview-title" className="image-preview-title" /><div id="image-preview-meta" className="image-preview-meta" /></div>
                <div className="selection-preview-actions"><ReaderButton id="explain-image" type="button" variant="text">{t("解读图示")}</ReaderButton><ReaderButton id="clear-image" type="button" variant="text">{t("移除图示")}</ReaderButton></div>
              </Paper>
              <label className="composer-question-label" htmlFor="question-input">{t("继续提问")}</label>
              <InputBase id="question-input" className="reader-composer-field" multiline inputComponent="textarea" rows={1} placeholder={t("问问这篇文章…")} sx={{ display: 'flex', width: '100%', padding: 0, '& textarea': { boxSizing: 'border-box' } }} />
              <div className="chat-composer-footer">
                <div className="composer-tools">
                  <ReaderButton id="chat-summary" type="button" title={t("总结当前整篇或选段")} variant="text"><ComposerIcon kind="summary" />{t("总结")}</ReaderButton>
                  <ReaderButton id="chat-translate" type="button" title={t("翻译当前整篇或选段")} variant="text"><ComposerIcon kind="translate" />{t("翻译")}</ReaderButton>
                  <TranslationLanguagePicker />
                </div>
              <Box sx={{ display: 'flex', alignItems: 'center', gap: space.sm, flex: '1 1 0', minWidth: 0 }}>
                <ReaderButton id="web-search-toggle" type="button" variant="text" aria-pressed="false" title={t("按需搜索公开网络；仅发送必要关键词，翻译和总结不联网。")}
                  sx={{ '&[aria-pressed="true"]': { bgcolor: 'action.selected', color: 'primary.main' } }}>
                  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" aria-hidden="true"><circle cx="12" cy="12" r="9"/><ellipse cx="12" cy="12" rx="4" ry="9"/><path d="M3 12h18M5 7h14M5 17h14"/></svg>
                  {t("联网补充")}
                </ReaderButton>
                <Typography id="web-search-state" variant="caption" color="text.secondary" noWrap>{t("已关闭")}</Typography>
              </Box>
                <span id="answer-task-status" className="small" role="status" aria-live="polite" /><ReaderButton id="stop-answer" className="composer-submit hidden" type="button" title={t("停止回答")} aria-label={t("停止回答")} variant="contained" control="icon"><ComposerIcon kind="stop" /></ReaderButton>
                <ReaderButton id="send-question" className="composer-submit" title={t("发送问题（⌘ / Ctrl + Enter）")} aria-label={t("发送问题")} variant="contained" control="icon"><ComposerIcon kind="send" /></ReaderButton>
              </div>
            </Paper>
          </div>
        </section>
      </section>

      <section id="settings-view" className="setting-panel hidden">
        <div className="settings-view-head">
          <div><div className="eyebrow">{t("设置")}</div><Typography component="h2" variant="h2">{t("模型与数据")}</Typography></div>
          <ReaderButton id="close-settings" type="button" variant="text">{t("返回聊天")}</ReaderButton>
        </div>
        <div className="mode-switch" role="group" aria-label={t("Reader 运行方式")}>
          <ReaderButton id="mode-local" className="mode-option" variant="outlined" type="button" aria-pressed="true" control="mode">
            <span className="mode-option-content"><strong>{t("独立模式")}</strong><span>{t("自带模型，本地保存")}</span></span><span className="mode-option-check" aria-hidden="true"><ComposerIcon kind="check" /></span>
          </ReaderButton>
          <ReaderButton id="mode-platform" className="mode-option" variant="outlined" type="button" aria-pressed="false" control="mode">
            <span className="mode-option-content"><strong>{t("平台模式")}</strong><span>{t("平台 AI Engine，数据库同步")}</span></span><span className="mode-option-check" aria-hidden="true"><ComposerIcon kind="check" /></span>
          </ReaderButton>
        </div>
        <Alert id="mode-guidance" className="mode-guidance hidden" role="status" aria-live="polite"  icon={false} severity="info" />

        <section className="settings-card">
          <div className="field"><label htmlFor="interface-language">{t('界面语言')}</label><ReaderSelect id="interface-language" defaultValue="system"><option value="system">{t('跟随浏览器')}</option><option value="zh-CN">简体中文</option><option value="en">English</option></ReaderSelect></div>
          <p className="small">{t('回答跟随提问语言；翻译可在输入区旁选择目标语言，并自动记住。')}</p>
        </section>

        <section id="platform-settings" className="settings-card">
          <div className="settings-card-heading">
            <div><div className="settings-kicker">Deep Research</div><Typography component="h3" variant="h3">{t("连接调研平台")}</Typography></div>
            <span id="platform-status" className="connection-badge">{t("未连接")}</span>
          </div>
          <p className="small">{t("问答、总结、选段翻译、全文翻译和图片文字翻译使用调研平台 AI Engine；阅读会话和确认保存的结论同步到 PostgreSQL。全文仅在你发起操作时发送。图片字节由浏览器读取后按需上传，不上传图片 URL；翻译缓存保留在本地。")}</p>
          <p className="small">{t("目标平台：")}<strong id="platform-target">techradar.top</strong></p>
          <div className="actions">
            <ReaderButton id="connect-platform" variant="contained">{t("连接平台")}</ReaderButton>
            <ReaderButton id="disconnect-platform" className="hidden" variant="outlined" color="error">{t("断开连接")}</ReaderButton>
            <ReaderButton id="restore-session" className="hidden" variant="outlined">{t("恢复云端会话")}</ReaderButton>
          </div>
        </section>

        <section id="local-provider-settings" className="settings-card">
          <div className="settings-card-heading">
            <Typography component="h3" variant="h3">{t("连接模型服务")}</Typography>
            <span id="provider-connection-state" className="connection-badge">{t("未连接")}</span>
          </div>
          <ProviderSelector />
          <div id="provider-custom-url-field" className="field"><label htmlFor="provider-url">{t("API 地址")}</label><ReaderTextField id="provider-url" type="url" className="reader-settings-field" placeholder="https://api.example.com/v1" autoComplete="off" slotProps={{ htmlInput: { spellCheck: false, 'aria-describedby': 'provider-endpoint-hint model-discovery-status' } }} /></div>
          <div id="provider-endpoint-hint" className="small provider-endpoint-hint" />
          <div className="field"><label id="provider-key-label" htmlFor="provider-key">API Key</label><div className="provider-key-control"><ReaderTextField id="provider-key" className="reader-settings-field" type="password" autoComplete="off" placeholder={t("输入服务商提供的 Key")} slotProps={{ htmlInput: { spellCheck: false, 'aria-describedby': 'model-discovery-status' } }} /><ReaderButton id="provider-key-toggle" className="provider-key-toggle" type="button" aria-label={t("显示 API Key")} title={t("显示 API Key")} aria-pressed="false" variant="outlined" control="icon"><ComposerIcon kind="eye" /></ReaderButton></div></div>
          <ReaderButton id="refresh-models" className="provider-connect" type="button" variant="contained">{t("连接并获取模型")}</ReaderButton>
          <div id="model-discovery-status" className="provider-feedback" role="status" aria-live="polite" />
          <div className="field provider-model-field"><label htmlFor="provider-model-list">{t("模型")}</label><ReaderTextField id="provider-model-search" type="search" className="hidden" placeholder={t("搜索模型")} aria-label={t("搜索模型")}  /><ReaderSelect id="provider-model-list"><option value="">{t("请先连接模型服务")}</option></ReaderSelect><ReaderDisclosure id="manual-model-settings" label={<>{t("手动指定模型 ID")}</>}><label htmlFor="provider-model">{t("模型 ID")}</label><ReaderTextField id="provider-model" className="reader-settings-field" placeholder={t("填写服务商提供的模型 ID")} slotProps={{ htmlInput: { spellCheck: false } }} /></ReaderDisclosure></div>
          <div className="actions provider-save-actions"><ReaderButton id="save-settings" type="button" variant="contained">{t("保存配置")}</ReaderButton><ReaderButton id="test-provider" type="button" variant="outlined">{t("测试连接")}</ReaderButton></div>
          <div id="provider-test-status" className="provider-feedback" role="status" aria-live="polite" />
          <ReaderDisclosure className="provider-extra-checks" label={<>{t("图片能力")}</>}><ReaderButton id="test-vision" type="button" variant="outlined">{t("检测图片能力")}</ReaderButton></ReaderDisclosure>
        </section>
              <Alert id="settings-notice" className="notice hidden" role="status" aria-live="polite"  icon={false} severity="info" />
        <div className="section-label"><Typography component="h2" variant="h3">{t("本地数据")}</Typography></div>
        <div className="actions"><ReaderButton id="export-data" variant="outlined">{t("导出阅读数据")}</ReaderButton><ReaderButton id="import-data" variant="outlined">{t("导入数据")}</ReaderButton><ReaderButton id="clear-cache" variant="outlined" color="error">{t("清除翻译缓存")}</ReaderButton><ReaderButton id="clear-data" variant="outlined" color="error">{t("清除本地数据")}</ReaderButton></div>
        <p className="small" style={{ marginTop: 8 }}>{t("卸载扩展前请先导出需要保留的阅读成果；卸载后浏览器本地数据不保证恢复。")}</p>
        <input id="import-file" type="file" accept="application/json" className="hidden" />
        <p className="small" style={{ marginTop: 20 }}><a href="privacy.html" target="_blank" rel="noreferrer">{t("隐私政策")}</a> · <a href="https://techradar.top/reading/support" target="_blank" rel="noreferrer">{t("使用与支持 ↗")}</a></p>
      </section>

      <section id="save-dialog" className="setting-panel hidden">
        <div className="eyebrow">{t("保存阅读成果")}</div>
        <Typography component="h2" variant="h2">{t("留下以后能复用的结论")}</Typography>
        <p id="save-mode-note" className="small" style={{ marginTop: 8 }}>{t("保存为可检索的阅读结论卡，不会在原文添加高亮。")}</p>
        <div className="card"><div className="card-title"><label htmlFor="save-quote">{t("原文摘录")}</label><span id="save-source-title">{t("当前页面")}</span></div><ReaderTextField id="save-quote" style={{ marginTop: 9, minHeight: 100 }}  multiline minRows={3} /></div>
        <div className="field"><label htmlFor="save-note">{t("我的笔记")}</label><ReaderTextField id="save-note" placeholder={t("补充自己的判断、待验证问题或使用场景")}  multiline minRows={3} /></div>
        <div className="field"><label htmlFor="save-ai-answer">{t("要保存的 AI 结论")}</label><ReaderTextField id="save-ai-answer" placeholder={t("可以删掉不想长期保留的部分")}  multiline minRows={3} /></div>
        <div className="field"><label htmlFor="save-tags">{t("标签（用逗号分隔，最多 10 个）")}</label><ReaderTextField id="save-tags" placeholder={t("架构, 性能, 待验证")}  /></div>
        <Alert id="save-notice" className="notice hidden" role="status" aria-live="polite"  icon={false} severity="info" />
        <div className="actions"><ReaderButton id="confirm-save" variant="contained">{t("保存到阅读库")}</ReaderButton><ReaderButton id="cancel-save" variant="outlined">{t("取消")}</ReaderButton></div>
      </section>

      <section id="annotation-dialog" className="setting-panel hidden">
        <div className="eyebrow">{t("原文标注")}</div><Typography component="h2" variant="h2">{t("给这段内容留下位置标记")}</Typography>
        <p className="small">{t("保存后会按原文位置叠加高亮，并保留一条短笔记；不会创建阅读结论卡。仅在原文版本匹配时高亮，标注保存在浏览器本地。")}</p>
        <div className="field"><label htmlFor="annotation-quote">{t("待标注原文")}</label><span id="annotation-source-title" className="small" /><ReaderTextField id="annotation-quote" multiline minRows={3} slotProps={{ htmlInput: { readOnly: true } }} /></div>
        <div className="field"><label htmlFor="annotation-note">{t("标注笔记")}</label><ReaderTextField id="annotation-note" multiline minRows={3} placeholder={t("例如：这里是性能瓶颈的关键假设")} /></div>
        <Alert id="annotation-notice" className="notice hidden" icon={false} severity="info" />
        <div className="actions"><ReaderButton id="confirm-annotation" variant="contained">{t("保存标注并高亮")}</ReaderButton><ReaderButton id="cancel-annotation" variant="outlined">{t("取消")}</ReaderButton></div>
      </section>

      <div id="mode-data-note" className="footer">{t("独立模式：模型请求与阅读成果保存在本地，可导出或清除。")}</div>

    </Box>
  );
}

void initializeLocale().then(() => createRoot(document.getElementById('root')!).render(<ReaderThemeProvider><ReaderPanel /></ReaderThemeProvider>));
