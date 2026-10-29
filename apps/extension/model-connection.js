export class ModelConnectionError extends Error {
  constructor(code, message, field = '', status = 0) {
    super(message);
    this.name = 'ModelConnectionError';
    this.code = code;
    this.field = field;
    this.status = status;
  }
}

export function isLoopbackEndpoint(value) {
  try { return ['localhost', '127.0.0.1', '[::1]'].includes(new URL(value).hostname); }
  catch { return false; }
}

export function normalizeModelBaseUrl(value, kind = '') {
  let url;
  try { url = new URL(String(value || '').trim()); }
  catch { throw new ModelConnectionError('ADDRESS', '请输入完整的 API 地址，例如 https://example.com/v1', 'provider-url'); }
  if (!['https:', 'http:'].includes(url.protocol)) {
    throw new ModelConnectionError('ADDRESS', '模型服务地址必须使用 HTTP(S)', 'provider-url');
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new ModelConnectionError('ADDRESS', 'API 地址不要包含账号、查询参数或页面锚点', 'provider-url');
  }
  url.pathname = url.pathname.replace(/\/+$/u, '').replace(/\/(?:chat\/completions|messages|models)$/u, '');
  if (isLoopbackEndpoint(url.href) && ['local-proxy', 'lm-studio', 'ollama'].includes(kind) && (!url.pathname || url.pathname === '/')) {
    url.pathname = '/v1';
  }
  if (kind === 'ollama' && url.pathname === '/api') url.pathname = '/v1';
  return url.href.replace(/\/+$/u, '');
}

export function validateModelConnection(provider, { requireModel = false } = {}) {
  const candidate = {
    ...provider,
    baseUrl: normalizeModelBaseUrl(provider?.baseUrl, provider?.providerKind),
    apiKey: String(provider?.apiKey || '').trim(),
    model: String(provider?.model || '').trim(),
  };
  if (!candidate.apiKey && !isLoopbackEndpoint(candidate.baseUrl)) {
    throw new ModelConnectionError('KEY_REQUIRED', '请先填写这个服务的 API Key', 'provider-key');
  }
  if (requireModel && !candidate.model) {
    throw new ModelConnectionError('MODEL_REQUIRED', '请先连接获取模型，或手动指定模型 ID', 'provider-model-list');
  }
  return candidate;
}

export function modelConnectionError(error, provider = {}) {
  if (error instanceof ModelConnectionError) return error;
  if (error?.name === 'AbortError' || error?.name === 'TimeoutError') {
    return new ModelConnectionError('TIMEOUT', '连接超时，请确认服务正在运行后重试', 'provider-url');
  }
  let message = String(error?.message || '连接失败');
  if (provider.apiKey) message = message.split(provider.apiKey).join('[已隐藏]');
  if (/fetch|network|load failed|cors/iu.test(message)) {
    return new ModelConnectionError('NETWORK', '无法连接服务，请检查 API 地址、服务运行状态及站点访问权限', 'provider-url');
  }
  return new ModelConnectionError('REQUEST', message);
}

export function modelResponseError(status, message, provider) {
  if ([401, 403].includes(status)) {
    return new ModelConnectionError('AUTH', isLoopbackEndpoint(provider?.baseUrl)
      ? `本地服务已响应，但模型认证失败（${status}）。请检查代理访问 Key 或上游账号`
      : `模型认证失败（${status}），请检查 API Key 和模型访问权限`,
    isLoopbackEndpoint(provider?.baseUrl) ? 'provider-model-list' : 'provider-key', status);
  }
  if (status === 404) return new ModelConnectionError('MODEL', '服务未找到所选模型，请刷新列表或更换模型', 'provider-model-list', status);
  if (status === 429) return new ModelConnectionError('RATE_LIMIT', '模型服务限流或额度不足，请稍后重试', '', status);
  let detail = String(message || `模型请求失败（${status}）`);
  if (provider?.apiKey) detail = detail.split(provider.apiKey).join('[已隐藏]');
  return new ModelConnectionError('REQUEST', detail.slice(0, 300), '', status);
}

function httpError(status) {
  if ([401, 403].includes(status)) {
    return new ModelConnectionError('AUTH', `服务拒绝认证（${status}），请检查 API Key 和账号权限`, 'provider-key', status);
  }
  if ([404, 405, 501].includes(status)) {
    return new ModelConnectionError('MODELS_UNSUPPORTED', '此地址没有提供模型列表，请检查 API 地址，或手动指定模型 ID', 'provider-url', status);
  }
  if (status === 429) return new ModelConnectionError('RATE_LIMIT', '服务请求过于频繁或额度不足，请稍后重试', '', status);
  return new ModelConnectionError('SERVICE', `模型服务暂时不可用（${status}），请稍后重试`, '', status);
}

export async function fetchProviderModels(provider, headers, options = {}) {
  const candidate = validateModelConnection(provider);
  const url = new URL(`${candidate.baseUrl}/models`);
  const controller = new AbortController();
  const abort = () => controller.abort(options.signal?.reason);
  options.signal?.addEventListener('abort', abort, { once: true });
  if (options.signal?.aborted) abort();
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; controller.abort(); }, options.timeoutMs ?? 8_000);
  const models = new Map();
  const cursors = new Set();
  const requestHeaders = { ...headers };
  delete requestHeaders['content-type'];
  try {
    for (let page = 0; page < 100; page += 1) {
      const response = await (options.fetch || fetch)(url, { headers: requestHeaders, signal: controller.signal });
      if (!response.ok) throw httpError(response.status);
      let payload;
      try { payload = await response.json(); }
      catch { throw new ModelConnectionError('RESPONSE', '这个地址没有返回模型数据，请填写 API 接口地址', 'provider-url'); }
      const items = Array.isArray(payload) ? payload : payload?.data || payload?.models;
      if (!Array.isArray(items)) {
        throw new ModelConnectionError('RESPONSE', '服务返回的模型列表格式无法识别，请检查接口地址', 'provider-url');
      }
      for (const model of items) {
        const id = typeof model === 'string' ? model : model?.id || model?.name || model?.model;
        if (typeof id !== 'string' || !id.trim()) continue;
        models.set(id.trim(), { id: id.trim(), label: String(model?.display_name || model?.displayName || (model?.id && model?.name) || id).trim() });
      }
      const cursor = payload.next_page_token ? ['page_token', payload.next_page_token]
        : payload.nextPageToken ? ['pageToken', payload.nextPageToken]
          : payload.next_cursor ? ['cursor', payload.next_cursor]
            : payload.has_more && payload.last_id ? ['after_id', payload.last_id] : null;
      if (!cursor && !payload.has_more) break;
      const key = JSON.stringify(cursor);
      if (!cursor || cursors.has(key) || page === 99) {
        throw new ModelConnectionError('INCOMPLETE_MODELS', '服务的模型列表未完整读取，请刷新重试，或手动指定模型 ID', 'provider-model-list');
      }
      cursors.add(key);
      url.searchParams.set(...cursor);
    }
    if (!models.size) throw new ModelConnectionError('EMPTY_MODELS', '服务当前没有可用模型，请先加载模型或手动指定模型 ID', 'provider-model-list');
    return [...models.values()].sort((a, b) => a.label.localeCompare(b.label));
  } catch (error) {
    if (options.signal?.aborted) throw error;
    if (timedOut) throw new ModelConnectionError('TIMEOUT', '获取模型超时，请确认服务正在运行后重试', 'provider-url');
    throw modelConnectionError(error, candidate);
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener('abort', abort);
  }
}
