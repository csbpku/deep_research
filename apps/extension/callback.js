const params = new URLSearchParams(location.search);
const code = params.get('code');
const state = params.get('state');
const message = document.querySelector('p');
if (!code || !state) {
  message.textContent = '授权参数无效，请从 Reader 侧栏重新连接。';
} else {
  message.textContent = '正在完成安全连接…';
  chrome.runtime.sendMessage({ type: 'deep-research:exchange-code', code, state })
    .then((result) => {
      if (!result?.ok) throw new Error(result?.message || '平台授权失败');
      message.textContent = '已连接 Deep Research，可以关闭此页面。';
      setTimeout(() => window.close(), 600);
    })
    .catch((error) => {
      message.textContent = error instanceof Error ? error.message : '平台授权失败，请重新连接。';
    });
}
