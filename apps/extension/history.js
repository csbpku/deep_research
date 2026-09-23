import { readerStore } from './reader-store.js';
import { renderMarkdown } from './markdown-renderer.js';
import { resolvePlatformOrigin } from './platform-config.js';

let sessions = [];
let insights = [];
let activeTab = 'sessions';
let query = '';
let toastTimer = 0;
let activeDetail = null;
const sidePanelSurface = new URLSearchParams(window.location.search).get('surface') === 'sidepanel';
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
    return text(url, '未知来源');
  }
}

function sessionIdentity(session) {
  return `${readerStore.pageKey(session.url)}::${session.version || 'latest'}`;
}

async function loadCloudSessions() {
  const { readerToken } = await chrome.storage.local.get(['readerToken']);
  if (!readerToken) return [];
  const platformUrl = resolvePlatformOrigin(await readerStore.getSetting('platformUrl', ''));
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
  return Number.isNaN(date.getTime()) ? '时间未知' : date.toLocaleString([], { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

function recentQuestion(session) {
  const messages = Array.isArray(session?.discussion) ? session.discussion : [];
  const question = [...messages].reverse().find((item) => item?.role === 'user' && typeof item.content === 'string' && item.content.trim());
  return text(question?.content, '还没有提问；下次打开原文可以继续。');
}

function messageCount(session) {
  return Array.isArray(session?.discussion) ? session.discussion.length : 0;
}

function scopeLabel(session) {
  const scope = session?.discussionScope;
  if (scope === 'page') return '整页正文';
  if (scope === 'image') return '当前图示';
  return '当前选段';
}

function intentLabel(session) {
  if (session?.discussionIntent === 'summary') return '全文总结';
  if (session?.discussionIntent === 'ask') return '提问';
  return '解读';
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
  showToast(`已导出 ${records.length} 条${kind === 'sessions' ? '聊天会话' : '知识结论'}。`);
}

function makeAction(label, handler, danger = false) {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = `history-card-action${danger ? ' danger' : ''}`;
  button.textContent = label;
  button.addEventListener('click', () => void handler());
  return button;
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
      showToast('没有获得原文站点权限；请允许访问后再继续聊天。');
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
    const [activeTab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
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
      window.location.href = chrome.runtime.getURL('sidepanel.html');
    } else if (Number.isInteger(tab?.id)) {
      await chrome.sidePanel.open({ tabId: tab.id }).catch(() => {});
    }
    showToast(sessionIsOld(session)
      ? '原文已打开；这是旧版本，已恢复会话但原文证据需要重新核对。'
      : '原文已打开；Reader 正在恢复这次聊天，可以继续提问。');
  } catch {
    showToast('无法打开原文，请复制来源地址后重试。');
  }
}

function renderHistoryDetail(session) {
  activeDetail = session;
  $('history-list').classList.add('hidden');
  $('history-detail').classList.remove('hidden');
  $('history-detail-title').textContent = text(session.title, pageLabel(session.url));
  $('history-detail-source').textContent = session.url || pageLabel(session.url);
  $('history-detail-scope').textContent = `${scopeLabel(session)} · ${intentLabel(session)}`;
  $('history-detail-time').textContent = `更新于 ${formatTime(session.updatedAt)}`;

  const selection = $('history-detail-selection');
  selection.textContent = '';
  if (session.selection?.quote) {
    selection.classList.remove('hidden');
    const label = document.createElement('div');
    label.className = 'history-detail-label';
    label.textContent = '当时选中的原文';
    const quote = document.createElement('div');
    quote.className = 'history-detail-quote';
    quote.textContent = session.selection.quote;
    selection.append(label, quote);
  } else {
    selection.classList.add('hidden');
  }

  const messages = $('history-detail-messages');
  messages.textContent = '';
  const discussion = Array.isArray(session.discussion) ? session.discussion : [];
  if (!discussion.length) {
    const empty = document.createElement('div');
    empty.className = 'history-detail-empty';
    empty.textContent = '这条会话还没有完成的问答。';
    messages.appendChild(empty);
  } else {
    discussion.forEach((item) => {
      if (!item || !['user', 'assistant'].includes(item.role) || !String(item.content || '').trim()) return;
      const message = document.createElement('article');
      message.className = `history-detail-message ${item.role === 'user' ? 'user' : 'assistant'}`;
      const header = document.createElement('div');
      header.className = 'history-detail-message-header';
      header.textContent = item.role === 'user' ? '你' : 'Reader';
      const body = document.createElement('div');
      body.className = 'history-detail-message-body';
      if (item.role === 'assistant') renderMarkdown(body, item.content);
      else body.textContent = item.content;
      message.append(header, body);
      messages.appendChild(message);
    });
  }

  const structured = $('history-detail-structured');
  const answer = session.answerStructured && typeof session.answerStructured === 'object' ? session.answerStructured : null;
  const evidence = $('history-detail-evidence');
  evidence.textContent = '';
  if (answer) {
    const evidenceItems = Array.isArray(answer.evidence) ? answer.evidence : [];
    evidenceItems.forEach((item, index) => {
      const row = document.createElement('button');
      row.type = 'button';
      row.className = 'history-detail-evidence-item';
      row.title = item.anchor?.quote ? '打开原文并跳转到这条证据' : '这条证据没有可用的原文定位';
      const number = document.createElement('span');
      number.className = 'history-detail-evidence-index';
      number.textContent = `[${index + 1}]`;
      const content = document.createElement('span');
      content.className = 'history-detail-evidence-content';
      const quote = document.createElement('span');
      quote.className = 'history-detail-quote';
      quote.textContent = `“${item.quote || ''}”`;
      content.appendChild(quote);
      if (item.claim) {
        const claim = document.createElement('span');
        claim.className = 'history-detail-claim';
        claim.textContent = item.claim;
        content.appendChild(claim);
      }
      row.append(number, content);
      row.addEventListener('click', () => void openSession(session, { anchor: item.anchor }));
      evidence.appendChild(row);
    });
    const background = $('history-detail-background');
    renderMarkdown(background.querySelector('span'), answer.background || '');
    background.classList.toggle('hidden', !answer.background);
    const inference = $('history-detail-inference');
    renderMarkdown(inference.querySelector('span'), answer.inference || '');
    inference.classList.toggle('hidden', !answer.inference);
    const limitations = $('history-detail-limitations');
    renderMarkdown(limitations.querySelector('span'), Array.isArray(answer.limitations) ? answer.limitations.join('\n') : '');
    limitations.classList.toggle('hidden', !answer.limitations?.length);
    structured.classList.toggle('hidden', Boolean(!evidenceItems.length && !answer.background && !answer.inference && !answer.limitations?.length));
  } else {
    structured.classList.add('hidden');
  }
}

function closeHistoryDetail() {
  activeDetail = null;
  $('history-detail').classList.add('hidden');
  $('history-list').classList.remove('hidden');
}

async function renameSession(session) {
  const next = window.prompt('重命名聊天会话', session.title || pageLabel(session.url));
  if (next === null) return;
  const title = next.trim().slice(0, 500);
  if (!title) return showToast('名称不能为空。');
  await readerStore.saveSession({ ...session, title, titleEdited: true });
  await loadData();
  showToast('会话名称已更新。');
}

async function deleteSession(session) {
  if (!window.confirm(`删除“${session.title || pageLabel(session.url)}”的本地聊天会话？`)) return;
  await readerStore.deleteSession(session.url, session.version || null);
  await loadData();
  showToast('聊天会话已删除。');
}

async function renameInsight(insight) {
  const next = window.prompt('重命名知识结论', insight.title || text(insight.quote, '未命名结论').slice(0, 80));
  if (next === null) return;
  const title = next.trim().slice(0, 500);
  if (!title) return showToast('名称不能为空。');
  await readerStore.saveInsight({ ...insight, title, updatedAt: new Date().toISOString() });
  await loadData();
  showToast('知识结论名称已更新。');
}

async function deleteInsight(insight) {
  if (!window.confirm(`删除“${insight.title || '这条知识结论'}”？`)) return;
  await readerStore.deleteInsight(insight.id);
  await loadData();
  showToast('知识结论已删除。');
}

function renderEmpty(title, detail) {
  const list = $('history-list');
  list.textContent = '';
  const empty = document.createElement('div');
  empty.className = 'history-empty';
  const heading = document.createElement('strong');
  heading.textContent = title;
  const copy = document.createElement('span');
  copy.textContent = detail;
  empty.append(heading, copy);
  list.appendChild(empty);
}

function renderSessionCard(session) {
  const card = document.createElement('article');
  card.className = 'history-card';
  const top = document.createElement('div');
  top.className = 'history-card-top';
  const heading = document.createElement('div');
  heading.className = 'history-card-title';
  heading.textContent = text(session.title, pageLabel(session.url));
  const status = document.createElement('span');
  status.className = 'history-status';
  status.textContent = session.remote ? '平台同步' : sessionIsOld(session) ? '旧版本' : '当前版本';
  status.style.background = sessionIsOld(session) ? '' : '#edf5ee';
  status.style.color = sessionIsOld(session) ? '' : '#347253';
  top.append(heading, status);
  const source = document.createElement('div');
  source.className = 'history-card-source';
  source.textContent = session.url;
  const question = document.createElement('div');
  question.className = 'history-question';
  const questionLabel = document.createElement('span');
  questionLabel.className = 'history-question-label';
  questionLabel.textContent = '最近问题';
  const questionText = document.createElement('span');
  questionText.textContent = recentQuestion(session);
  question.append(questionLabel, questionText);
  const meta = document.createElement('div');
  meta.className = 'history-card-meta';
  meta.innerHTML = '<span data-meta="source"></span><span data-meta="scope"></span><span data-meta="time"></span><span data-meta="messages"></span>';
  meta.querySelector('[data-meta="source"]').textContent = pageLabel(session.url);
  meta.querySelector('[data-meta="scope"]').textContent = `${scopeLabel(session)} · ${intentLabel(session)}`;
  meta.querySelector('[data-meta="time"]').textContent = `更新于 ${formatTime(session.updatedAt)}`;
  meta.querySelector('[data-meta="messages"]').textContent = `${messageCount(session)} 条消息`;
  const actions = document.createElement('div');
  actions.className = 'history-card-actions';
  actions.append(makeAction('继续聊天', () => openSession(session)), makeAction('查看对话', () => renderHistoryDetail(session)), makeAction('打开原文', () => openSession(session)));
  if (!session.remote) {
    actions.append(
      makeAction('重命名', () => renameSession(session)),
      makeAction('导出', () => exportRecords('sessions', [session])),
      makeAction('删除', () => deleteSession(session), true),
    );
  }
  card.append(top, source, question, meta, actions);
  return card;
}

function renderInsightCard(insight) {
  const card = document.createElement('article');
  card.className = 'history-card';
  const top = document.createElement('div');
  top.className = 'history-card-top';
  const heading = document.createElement('div');
  heading.className = 'history-card-title';
  heading.textContent = text(insight.title, text(insight.quote, '未命名结论').slice(0, 80));
  top.appendChild(heading);
  const source = document.createElement('div');
  source.className = 'history-card-source';
  source.textContent = insight.url || '本地知识结论';
  const quote = document.createElement('div');
  quote.className = 'history-insight-quote';
  quote.textContent = text(insight.quote, '没有保存原文摘录。');
  card.append(top, source, quote);
  if (insight.aiAnswer) {
    const answer = document.createElement('div');
    answer.className = 'history-insight-answer';
    renderMarkdown(answer, insight.aiAnswer);
    card.appendChild(answer);
  }
  if (Array.isArray(insight.tags) && insight.tags.length) {
    const tags = document.createElement('div');
    tags.className = 'history-tags';
    insight.tags.forEach((tag) => { const node = document.createElement('span'); node.className = 'history-tag'; node.textContent = tag; tags.appendChild(node); });
    card.appendChild(tags);
  }
  const meta = document.createElement('div');
  meta.className = 'history-card-meta';
  meta.textContent = `收藏于 ${formatTime(insight.updatedAt || insight.createdAt)}`;
  const actions = document.createElement('div');
  actions.className = 'history-card-actions';
  actions.append(
    makeAction('重命名', () => renameInsight(insight)),
    makeAction('导出', () => exportRecords('insights', [insight])),
    makeAction('删除', () => deleteInsight(insight), true),
  );
  card.append(meta, actions);
  return card;
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
  $('history-section-kicker').textContent = activeTab === 'sessions' ? 'READING SESSIONS' : 'SAVED INSIGHTS';
  $('history-section-title').textContent = activeTab === 'sessions' ? '聊天会话' : '知识结论';
  $('history-summary-text').textContent = `${filtered.length} 条${activeTab === 'sessions' ? '会话' : '结论'}`;
  $('history-filter-text').textContent = query ? `匹配“${query}”` : '';
  const list = $('history-list');
  list.textContent = '';
  if (!filtered.length) {
    renderEmpty(query ? '没有匹配项' : (activeTab === 'sessions' ? '还没有聊天会话' : '还没有知识结论'), query ? '换个关键词搜索页面标题、来源或历史问题。' : (activeTab === 'sessions' ? '在原网页中选择一段内容并开始讨论，记录会自动出现在这里。' : '在侧栏确认保存 AI 结论，它会独立出现在这里。'));
    return;
  }
  filtered.forEach((item) => list.appendChild(activeTab === 'sessions' ? renderSessionCard(item) : renderInsightCard(item)));
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
}

function setTab(next) {
  if (activeDetail) closeHistoryDetail();
  activeTab = next === 'insights' ? 'insights' : 'sessions';
  document.querySelectorAll('[data-history-tab]').forEach((button) => button.classList.toggle('active', button.dataset.historyTab === activeTab));
  render();
}

function closeHistory() {
  if (sidePanelSurface) {
    window.location.href = chrome.runtime.getURL('sidepanel.html');
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
$('close-history-detail').addEventListener('click', closeHistoryDetail);
$('continue-history-detail').addEventListener('click', () => {
  if (activeDetail) void openSession(activeDetail);
});
$('export-history').addEventListener('click', () => void exportRecords(activeTab, (activeTab === 'sessions' ? sessions : insights).filter(activeTab === 'sessions' ? sessionMatches : insightMatches)));
void loadData();
