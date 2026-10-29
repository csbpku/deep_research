import { renderMaterialConversation, renderMaterialEvidence, renderMaterialRecords } from './components/material-runtime.tsx';
import { t, getUiLanguage } from './i18n.js';
import { readerStore } from './reader-store.js';
import { renderMarkdown } from './markdown-renderer.js';
import { resolvePlatformOrigin, tokenBoundToOrigin } from './platform-config.js';

let sessions = [];
let insights = [];
let activeTab = 'sessions';
let query = '';
let toastTimer = 0;
let activeDetail = null;
let activeDetailReturnFocus = null;
const sidePanelSurface = new URLSearchParams(window.location.search).get('surface') === 'sidepanel';
const sourceTab = Number(new URLSearchParams(window.location.search).get('sourceTab'));
const boundWindowTabId = sourceTab > 0 && Number.isInteger(sourceTab) ? sourceTab : null;
const pendingSessionKey = 'readerPendingSession';

const $ = (id) => document.getElementById(id);

function text(value, fallback = '') {
  const result = String(value ?? '').trim();
  return result || fallback;
}

function pageLabel(url) {
  try {
    const parsed = new URL(url);
    return `${parsed.hostname}${parsed.pathname === '/' ? '' : parsed.pathname}`;
  } catch {
    return text(url, t("未知来源"));
  }
}

function sessionIdentity(session) {
  return `${readerStore.pageKey(session.url)}::${session.version || 'latest'}`;
}

async function loadCloudSessions() {
  const { readerToken, readerTokenOrigin, readerPlatformUrl } = await chrome.storage.local.get(['readerToken', 'readerTokenOrigin', 'readerPlatformUrl']);
  if (!readerToken) return [];
  const platformUrl = resolvePlatformOrigin(await readerStore.getSetting('platformUrl', ''));
  if (!tokenBoundToOrigin(readerTokenOrigin || readerPlatformUrl || '', platformUrl)) return [];
  try {
    const response = await fetch(`${platformUrl}/api/reading/session`, {
      headers: { authorization: `Bearer ${readerToken}` },
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok || !Array.isArray(payload.sessions)) return [];
    return payload.sessions
      .filter((item) => item?.document?.url && item?.state && typeof item.state === 'object')
      .map((item) => ({
        ...item.state,
        id: `cloud:${item.clientId}:${sessionIdentity({ url: item.document.url, version: item.document.version })}`,
        url: item.document.url,
        title: item.document.title || item.document.url,
        version: item.document.version || null,
        updatedAt: item.updatedAt || new Date().toISOString(),
        remote: true,
      }));
  } catch {
    return [];
  }
}

function formatTime(value) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? t("时间未知") : date.toLocaleString(getUiLanguage(), { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

function recentQuestion(session) {
  const messages = Array.isArray(session?.discussion) ? session.discussion : [];
  const question = [...messages].reverse().find((item) => item?.role === 'user' && typeof item.content === 'string' && item.content.trim());
  return text(question?.content, t("还没有提问；下次打开原文可以继续。"));
}

function messageCount(session) {
  return Array.isArray(session?.discussion) ? session.discussion.length : 0;
}

function scopeLabel(session) {
  const scope = session?.discussionScope;
  if (scope === 'page') return t("整页正文");
  if (scope === 'image') return t("当前图示");
  return t("当前选段");
}

function intentLabel(session) {
  if (session?.discussionIntent === 'summary') return t("全文总结");
  if (session?.discussionIntent === 'ask') return t("提问");
  return t("解读");
}

function sessionIsOld(session) {
  if (session?.stale) return true;
  const samePage = sessions.filter((item) => readerStore.pageKey(item.url) === readerStore.pageKey(session.url));
  const newerVersion = samePage.some((item) => item.id !== session.id && item.version && item.version !== session.version && String(item.updatedAt) > String(session.updatedAt));
  return Boolean(newerVersion);
}

function sessionMatches(session) {
  const haystack = [session.title, session.url, recentQuestion(session), ...(Array.isArray(session.discussion) ? session.discussion.map((item) => item?.content || '') : [])].join('\n').toLocaleLowerCase();
  return !query || haystack.includes(query.toLocaleLowerCase());
}

function insightMatches(insight) {
  const haystack = [insight.title, insight.url, insight.quote, insight.note, insight.aiAnswer, ...(insight.tags || [])].join('\n').toLocaleLowerCase();
  return !query || haystack.includes(query.toLocaleLowerCase());
}

function showToast(message) {
  const node = $('history-toast');
  if (!node) return;
  node.textContent = message;
  node.classList.add('visible');
  window.clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => node.classList.remove('visible'), 2800);
}

/**
 * Toggle a region's visibility.
 *
 * React owns the class list of these regions and rewrites it on every
 * render (an MUI Accordion does so when it expands). A plain `hidden` class
 * toggle would therefore be undone by the next render, so the controller's
 * decision is recorded in `data-reader-visible` and re-applied by the
 * disclosure component after each render.
 */
function showRegion(el, visible = true) {
  if (!el) return;
  el.dataset.readerVisible = visible ? 'true' : 'false';
  el.classList.toggle('hidden', !visible);
}

function downloadJson(data, filename) {
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const objectUrl = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = objectUrl;
  link.download = filename;
  link.click();
  window.setTimeout(() => URL.revokeObjectURL(objectUrl), 0);
}

async function exportRecords(kind, records) {
  const data = await readerStore.exportData();
  if (kind === 'sessions') {
    data.sessions = data.sessions.filter((item) => records.some((record) => record.id === item.id));
    data.insights = [];
    data.annotations = [];
  } else {
    data.sessions = [];
    data.insights = data.insights.filter((item) => records.some((record) => record.id === item.id));
    data.annotations = [];
  }
  downloadJson(data, `deep-research-${kind}-${new Date().toISOString().slice(0, 10)}.json`);
  showToast(t("已导出 {0} 条{1}。", records.length, kind === 'sessions' ? t('聊天会话') : t('知识结论')));
}

async function ensurePagePermission(url) {
  try {
    const parsed = new URL(url);
    if (!/^https?:$/u.test(parsed.protocol) || !chrome.permissions?.contains) return true;
    const origin = `${parsed.origin}/*`;
    if (await chrome.permissions.contains({ origins: [origin] })) return true;
    return chrome.permissions.request ? await chrome.permissions.request({ origins: [origin] }) : false;
  } catch {
    return false;
  }
}

async function openSession(session, { anchor = null } = {}) {
  try {
    if (!(await ensurePagePermission(session.url))) {
      showToast(t("没有获得原文站点权限；请允许访问后再继续聊天。"));
      return;
    }
    await chrome.storage.session?.set?.({
      [pendingSessionKey]: {
        ...session,
        remote: undefined,
        resumedFromHistory: true,
        ...(anchor?.quote ? { pendingEvidenceAnchor: anchor } : {}),
        queuedAt: new Date().toISOString(),
      },
    });
    const activeTab = boundWindowTabId
      ? await chrome.tabs.get(boundWindowTabId).catch(() => null)
      : (await chrome.tabs.query({ active: true, lastFocusedWindow: true }))[0];
    let activeTabIsWeb = false;
    try {
      activeTabIsWeb = /^https?:$/u.test(new URL(activeTab?.url || '').protocol);
    } catch {
      activeTabIsWeb = false;
    }
    const tab = sidePanelSurface && Number.isInteger(activeTab?.id) && activeTabIsWeb
      ? await chrome.tabs.update(activeTab.id, { url: session.url, active: true })
      : await chrome.tabs.create({ url: session.url, active: true });
    if (sidePanelSurface) {
      window.location.href = chrome.runtime.getURL(`sidepanel.html${boundWindowTabId && tab?.id ? `?sourceTab=${tab.id}` : ''}`);
    } else if (Number.isInteger(tab?.id)) {
      await chrome.sidePanel.open({ tabId: tab.id }).catch(() => {});
    }
    showToast(sessionIsOld(session)
      ? t("原文已打开；这是旧版本，已恢复会话但原文证据需要重新核对。")
      : t("原文已打开；Reader 正在恢复这次聊天，可以继续提问。"));
  } catch {
    showToast(t("无法打开原文，请复制来源地址后重试。"));
  }
}

function renderHistoryDetail(session) {
  if (!activeDetail) {
    activeDetailReturnFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  }
  activeDetail = session;
  showRegion($('history-list'), false);
  showRegion($('history-detail'), true);
  $('history-detail-title').textContent = text(session.title, pageLabel(session.url));
  $('history-detail-source').textContent = session.url || pageLabel(session.url);
  $('history-detail-scope').textContent = `${scopeLabel(session)} · ${intentLabel(session)}`;
  $('history-detail-time').textContent = t("更新于 {0}", formatTime(session.updatedAt));

  const selection = $('history-detail-selection');
  selection.textContent = '';
  if (session.selection?.quote) {
    showRegion(selection, true);
    const label = document.createElement('div');
    label.className = 'history-detail-label';
    label.textContent = t("当时选中的原文");
    const quote = document.createElement('div');
    quote.className = 'history-detail-quote';
    quote.textContent = session.selection.quote;
    selection.append(label, quote);
  } else {
    showRegion(selection, false);
  }

  const messages = $('history-detail-messages');
  const discussion = (Array.isArray(session.discussion) ? session.discussion : []).filter(item => item && ['user', 'assistant'].includes(item.role) && String(item.content || '').trim());
  renderMaterialConversation(messages, discussion);
  const structured = $('history-detail-structured');
  const answer = session.answerStructured && typeof session.answerStructured === 'object' ? session.answerStructured : null;
  const evidence = $('history-detail-evidence');
  renderMaterialEvidence(evidence, []);
  if (answer) {
    const evidenceItems = Array.isArray(answer.evidence) ? answer.evidence : [];
    showRegion($('history-detail-evidence-section'), evidenceItems.length > 0);
    renderMaterialEvidence(evidence, evidenceItems.map(item => ({ claim: item.claim, quote: item.quote, url: session.url, anchored: Boolean(item.anchor?.quote), onLocate: () => void openSession(session, { anchor: item.anchor }) })));
    const background = $('history-detail-background');
    renderMarkdown(background.querySelector('span'), answer.background || '');
    showRegion(background, Boolean(answer.background));
    const inference = $('history-detail-inference');
    renderMarkdown(inference.querySelector('span'), answer.inference || '');
    showRegion(inference, Boolean(answer.inference));
    const limitations = $('history-detail-limitations');
    renderMarkdown(limitations.querySelector('span'), Array.isArray(answer.limitations) ? answer.limitations.join('\n') : '');
    showRegion(limitations, Boolean(answer.limitations?.length));
    const moreParts = [answer.background && t("背景"), answer.inference && t("推断"), answer.limitations?.length && t("未知项")].filter(Boolean);
    $('history-detail-more-summary').textContent = moreParts.join(' · ');
    showRegion($('history-detail-more'), moreParts.length > 0);
    $('history-detail-more').open = false;
    showRegion(structured, Boolean(evidenceItems.length || answer.background || answer.inference || answer.limitations?.length));
  } else {
    showRegion(structured, false);
  }
  $('history-detail-title').focus({ preventScroll: true });
}

function closeHistoryDetail({ restoreFocus = true } = {}) {
  activeDetail = null;
  showRegion($('history-detail'), false);
  showRegion($('history-list'), true);
  if (restoreFocus && activeDetailReturnFocus?.isConnected) activeDetailReturnFocus.focus();
  activeDetailReturnFocus = null;
}

async function renameSession(session) {
  const next = window.prompt(t("重命名聊天会话"), session.title || pageLabel(session.url));
  if (next === null) return;
  const title = next.trim().slice(0, 500);
  if (!title) return showToast(t("名称不能为空。"));
  await readerStore.saveSession({ ...session, title, titleEdited: true });
  await loadData();
  showToast(t("会话名称已更新。"));
}

async function deleteSession(session) {
  if (!window.confirm(t("删除“{0}”的本地聊天会话？", session.title || pageLabel(session.url)))) return;
  await readerStore.deleteSession(session.url, session.version || null);
  await loadData();
  showToast(t("聊天会话已删除。"));
}

async function renameInsight(insight) {
  const next = window.prompt(t("重命名知识结论"), insight.title || text(insight.quote, t("未命名结论")).slice(0, 80));
  if (next === null) return;
  const title = next.trim().slice(0, 500);
  if (!title) return showToast(t("名称不能为空。"));
  await readerStore.saveInsight({ ...insight, title, updatedAt: new Date().toISOString() });
  await loadData();
  showToast(t("知识结论名称已更新。"));
}

async function deleteInsight(insight) {
  if (!window.confirm(t("删除“{0}”？", insight.title || '这条知识结论'))) return;
  await readerStore.deleteInsight(insight.id);
  await loadData();
  showToast(t("知识结论已删除。"));
}

function renderEmpty(title, detail) {
  renderMaterialRecords($('history-list'), [], `${title}。${detail}`);
}
function sessionCard(session) {
  return { key: session.id, title: text(session.title, pageLabel(session.url)), source: session.url,
    status: session.remote ? t("平台同步") : sessionIsOld(session) ? t("旧版本") : t("当前版本"), warning: sessionIsOld(session),
    // The scope and the intent are the first thing a returning reader needs:
    // they say what this chat was about, not just when it happened.
    detail: recentQuestion(session), meta: `${scopeLabel(session)} · ${intentLabel(session)} · ${t("更新于 {0}", formatTime(session.updatedAt))} · ${t("{0} 条消息", messageCount(session))}`,
    visibleActions: 2, actions: [
      { label: t("继续聊天"), run: () => void openSession(session) },
      { label: t("查看对话"), run: () => renderHistoryDetail(session) },
      ...(!session.remote ? [
        { label: t("重命名"), run: () => void renameSession(session) },
        { label: t("导出"), run: () => void exportRecords('sessions', [session]) },
        { label: t("删除"), danger: true, run: () => void deleteSession(session) },
      ] : []),
    ] };
}
function insightCard(insight) {
  return { key: insight.id, title: text(insight.title, text(insight.quote, t("未命名结论")).slice(0, 80)), source: insight.url || t("本地知识结论"),
    detail: text(insight.quote, t("没有保存原文摘录。")), answer: insight.aiAnswer, tags: insight.tags,
    meta: t("收藏于 {0}", formatTime(insight.updatedAt || insight.createdAt)), visibleActions: 1, actions: [
      { label: t("重命名"), run: () => void renameInsight(insight) },
      { label: t("导出"), run: () => void exportRecords('insights', [insight]) },
      { label: t("删除"), danger: true, run: () => void deleteInsight(insight) },
    ] };
}

function render() {
  if (activeDetail) {
    const refreshed = sessions.find((item) => item.id === activeDetail.id);
    if (refreshed) renderHistoryDetail(refreshed);
    else closeHistoryDetail();
  }
  const source = activeTab === 'sessions' ? sessions : insights;
  const filtered = source.filter(activeTab === 'sessions' ? sessionMatches : insightMatches);
  $('session-count').textContent = String(sessions.length);
  $('insight-count').textContent = String(insights.length);
  $('history-section-kicker').textContent = activeTab === 'sessions' ? t("聊天会话") : t("知识结论");
  $('history-section-title').textContent = activeTab === 'sessions' ? t("聊天会话") : t("知识结论");
  $('history-summary-text').textContent = t("{0} 条{1}", filtered.length, activeTab === 'sessions' ? t('会话') : t('结论'));
  $('history-filter-text').textContent = query ? t("匹配“{0}”", query) : '';
  const list = $('history-list');
  if (!filtered.length) {
    renderEmpty(query ? t("没有匹配项") : (activeTab === 'sessions' ? t("还没有聊天会话") : t("还没有知识结论")), query ? t("换个关键词搜索页面标题、来源或历史问题。") : (activeTab === 'sessions' ? t("在原网页中选择一段内容并开始讨论，记录会自动出现在这里。") : t("在侧栏确认保存 AI 结论，它会独立出现在这里。")));
    return;
  }
  renderMaterialRecords(list, filtered.map(activeTab === 'sessions' ? sessionCard : insightCard));
}

async function loadData() {
  const [localSessions, cloudSessions, localInsights] = await Promise.all([
    readerStore.listSessions(),
    loadCloudSessions(),
    readerStore.listInsights(),
  ]);
  const mergedSessions = new Map();
  [...localSessions, ...cloudSessions].forEach((session) => {
    const key = sessionIdentity(session);
    const existing = mergedSessions.get(key);
    if (!existing || String(session.updatedAt).localeCompare(String(existing.updatedAt)) > 0) {
      mergedSessions.set(key, session);
    }
  });
  sessions = Array.from(mergedSessions.values()).sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
  insights = localInsights;
  render();
  $('history-tabs').setAttribute('aria-busy', 'false');
  document.querySelectorAll('[data-history-tab]').forEach((button) => { button.disabled = false; });
}

function setTab(next) {
  if (activeDetail) closeHistoryDetail({ restoreFocus: false });
  activeTab = next === 'insights' ? 'insights' : 'sessions';
  document.querySelectorAll('[data-history-tab]').forEach((button) => {
    const selected = button.dataset.historyTab === activeTab;
    button.classList.toggle('active', selected);
    button.setAttribute('aria-pressed', String(selected));
  });
  render();
}

function returnToPanel(view = 'chat') {
  const params = new URLSearchParams({ view });
  if (boundWindowTabId) params.set('sourceTab', String(boundWindowTabId));
  window.location.href = chrome.runtime.getURL(`sidepanel.html?${params}`);
}

function closeHistory() {
  if (sidePanelSurface) {
    returnToPanel();
    return;
  }
  chrome.tabs.getCurrent((tab) => {
    if (tab?.id) void chrome.tabs.remove(tab.id);
    else window.close();
  });
}

document.querySelectorAll('[data-history-tab]').forEach((button) => button.addEventListener('click', () => setTab(button.dataset.historyTab)));
$('history-search-input').addEventListener('input', (event) => { query = event.target.value.trim(); render(); });
$('clear-history-search').addEventListener('click', () => { $('history-search-input').value = ''; query = ''; render(); });
$('close-history').addEventListener('click', closeHistory);
$('history-library')?.addEventListener('click', () => returnToPanel('library'));
$('history-settings')?.addEventListener('click', () => returnToPanel('settings'));
$('history-current')?.addEventListener('click', () => { closeHistoryDetail({ restoreFocus: false }); $('history-search-input').focus(); });
document.addEventListener('pointerdown', event => document.querySelectorAll('.history-card-actions details[open]').forEach(menu => { if (!menu.contains(event.target)) menu.open = false; }));
document.addEventListener('keydown', event => { if (event.key === 'Escape') document.querySelectorAll('.history-card-actions details[open]').forEach(menu => { menu.open = false; menu.querySelector('summary')?.focus(); }); });
$('close-history-detail').addEventListener('click', closeHistoryDetail);
$('continue-history-detail').addEventListener('click', () => {
  if (activeDetail) void openSession(activeDetail);
});
$('export-history').addEventListener('click', () => void exportRecords(activeTab, (activeTab === 'sessions' ? sessions : insights).filter(activeTab === 'sessions' ? sessionMatches : insightMatches)));
void loadData();
