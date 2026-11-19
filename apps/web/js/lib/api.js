// 接口客户端与访问令牌。写请求绝不自动重放：失败只上报，由用户决定是否重试。

const TOKEN_KEY = 'super-mario-token';

export class ApiError extends Error {
  constructor(message, status) { super(message); this.name = 'ApiError'; this.status = status; }
}

const TOKEN_LIFETIME = 30 * 24 * 60 * 60 * 1000;
function remember(value) {
  const record = { value, expiresAt: Date.now() + TOKEN_LIFETIME };
  try {
    if (value) localStorage.setItem(TOKEN_KEY, JSON.stringify(record));
    else localStorage.removeItem(TOKEN_KEY);
    sessionStorage.removeItem(TOKEN_KEY);
  } catch { /* 禁用浏览器存储时仍可在当前页面连接。 */ }
  return record;
}
function readToken() {
  try {
    const saved = localStorage.getItem(TOKEN_KEY);
    if (saved) {
      const record = JSON.parse(saved);
      if (typeof record?.value === 'string' && record.expiresAt > Date.now()) return record;
      return remember('');
    }
    const legacy = sessionStorage.getItem(TOKEN_KEY);
    if (legacy) return remember(legacy);
  } catch { /* 无有效的本地凭据。 */ }
  return { value: '', expiresAt: 0 };
}

/**
 * 分享链接带令牌：优先放在 # 片段里（不会发给服务端），也兼容 ?token=。
 * 读取后立即从地址里抹掉，只保留页面路由。
 */
function consumeSharedToken() {
  const url = new URL(location.href);
  const fragment = url.hash.slice(1);
  const tokenOnly = fragment.startsWith('token=');
  const question = fragment.indexOf('?');
  const route = tokenOnly ? 'home' : question < 0 ? fragment : fragment.slice(0, question);
  const params = new URLSearchParams(tokenOnly ? fragment : question < 0 ? '' : fragment.slice(question + 1));
  const shared = params.get('token') ?? url.searchParams.get('token');
  if (shared === null) return null;
  params.delete('token');
  url.searchParams.delete('token');
  url.hash = `${route || 'home'}${params.size ? `?${params}` : ''}`;
  history.replaceState(history.state, '', url.pathname + url.search + url.hash);
  return shared.trim();
}

export function createApi() {
  let credential = readToken();
  const currentToken = () => credential.expiresAt > Date.now() ? credential.value : '';
  const shared = consumeSharedToken();
  if (shared !== null) credential = remember(shared);
  let onUnauthorized = () => {};

  async function api(path, { method = 'GET', body, headers, keepalive = false } = {}) {
    const token = currentToken();
    const init = {
      method,
      keepalive,
      headers: {
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        ...headers,
      },
    };
    if (body !== undefined) init.body = typeof body === 'string' ? body : JSON.stringify(body);
    let response;
    try { response = await fetch(`/api/v1${path}`, init); }
    catch { throw new ApiError('无法连接到服务，请检查网络', 0); }
    const data = response.status === 204 ? null : await response.json().catch(() => null);
    if (!response.ok) {
      if (response.status === 401) onUnauthorized();
      throw new ApiError(data?.error || `请求失败（${response.status}）`, response.status);
    }
    return data;
  }

  api.get = (path) => api(path);
  api.post = (path, body = {}, headers) => api(path, { method: 'POST', body, headers });
  api.put = (path, body) => api(path, { method: 'PUT', body });
  api.patch = (path, body) => api(path, { method: 'PATCH', body });
  api.del = (path) => api(path, { method: 'DELETE' });
  api.token = currentToken;
  api.setToken = (value) => { credential = remember(value.trim()); };
  api.onUnauthorized = (fn) => { onUnauthorized = fn; };
  return api;
}
