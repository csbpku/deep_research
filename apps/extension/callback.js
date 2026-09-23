const params = new URLSearchParams(location.search);
const token = params.get('token');
const code = params.get('code');
const state = params.get('state');
if (token) {
  chrome.storage.local.set({ readerToken: token }).then(() => {
    document.querySelector('p').textContent = '已连接 Deep Research，可以关闭此页面。';
    setTimeout(() => window.close(), 400);
  });
} else if (code && state) {
  chrome.runtime.sendMessage({ type: 'deep-research:exchange-code', code, state });
  document.querySelector('p').textContent = '正在完成安全连接…';
  setTimeout(() => window.close(), 1200);
}
