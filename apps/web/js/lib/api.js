// 接口客户端与访问令牌。写请求绝不自动重放：失败只上报，由用户决定是否重试。

const TOKEN_KEY = 'super-mario-token';

export class ApiError extends Error {
  constructor(message, status, retryAt) {
    super(message); this.name = 'ApiError'; this.status = status;
    if (status === 429 && typeof retryAt === 'string' && Number.isFinite(Date.parse(retryAt)))
      this.retryAt = new Date(retryAt).toISOString();
  }
}

const TOKEN_LIFETIME = 30 * 24 * 60 * 60 * 1000;
const ANONYMOUS_OWNER = 'super-mario-anonymous-draft-owner';
const validOwner = value => typeof value === 'string' && /^[a-f0-9]{32}$/.test(value);
const newOwner = () => Array.from(crypto.getRandomValues(new Uint8Array(16)), byte => byte.toString(16).padStart(2, '0')).join('');

function anonymous() {
  let owner;
  try {
    owner = localStorage.getItem(ANONYMOUS_OWNER);
    if (!validOwner(owner)) { owner = newOwner(); localStorage.setItem(ANONYMOUS_OWNER, owner); }
  } catch { /* A storage-restricted page retains its own anonymous identity. */ }
  return { value: '', expiresAt: 0, owner: validOwner(owner) ? owner : newOwner() };
}

function remember(value, previous) {
  let owner;
  if (value) {
    try {
      const saved = JSON.parse(localStorage.getItem(TOKEN_KEY));
      if (saved?.value === value && saved.expiresAt > Date.now() && validOwner(saved.owner)) owner = saved.owner;
    } catch { /* Reuse the current page's identity if storage is unavailable. */ }
    if (!owner && previous?.value === value && previous.expiresAt > Date.now()) owner = previous.owner;
  }
  const record = value ? { value, expiresAt: Date.now() + TOKEN_LIFETIME, owner: owner ?? newOwner() }
    : previous?.value === '' ? previous : anonymous();
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
      if (typeof record?.value === 'string' && record.value && Number.isFinite(record.expiresAt) && record.expiresAt > Date.now()) {
        // Upgrade existing credentials without extending their expiry.
        if (!validOwner(record.owner)) {
          record.owner = newOwner();
          try { localStorage.setItem(TOKEN_KEY, JSON.stringify(record)); } catch { /* Keep the upgrade in memory. */ }
        }
        return record;
      }
      return remember('');
    }
    const legacy = sessionStorage.getItem(TOKEN_KEY);
    if (legacy) return remember(legacy);
  } catch { /* 无有效的本地凭据。 */ }
  return anonymous();
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

async function readProgress(response, onProgress) {
  // Keep fragments of the final Markdown record without repeatedly copying its entire prefix.
  const fragments = [];
  for await (const chunk of response.body.pipeThrough(new TextDecoderStream())) {
    const lines = chunk.split('\n');
    for (let index = 0; index < lines.length - 1; index++) {
      fragments.push(lines[index]);
      const entry = JSON.parse(fragments.join(''));
      fragments.length = 0;
      if (entry.error) throw new Error(entry.error);
      if ('result' in entry) return entry.result;
      if (!entry.progress) throw new Error('导出进度格式无效');
      onProgress(entry.progress);
    }
    fragments.push(lines.at(-1));
  }
  throw new Error('导出连接提前结束，请重试');
}

export function createApi() {
  let credential = readToken();
  const current = () => {
    if (credential.value && credential.expiresAt <= Date.now()) credential = anonymous();
    return credential;
  };
  const currentToken = () => current().value;
  const shared = consumeSharedToken();
  if (shared !== null) credential = remember(shared, current());
  let onUnauthorized = () => {};

  async function api(path, { method = 'GET', body, headers, signal, onProgress, keepalive = false } = {}) {
    const { value: token, owner } = current();
    const init = {
      method,
      keepalive,
      signal,
      headers: {
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        ...(onProgress ? { Accept: 'application/x-ndjson' } : {}),
        ...headers,
      },
    };
    if (body !== undefined) init.body = typeof body === 'string' ? body : JSON.stringify(body);
    let response;
    try { response = await fetch(`/api/v1${path}`, init); }
    catch { throw new ApiError('无法连接到服务，请检查网络', 0); }
    if (response.ok && onProgress && response.headers.get('content-type')?.split(';')[0] === 'application/x-ndjson')
      return readProgress(response, onProgress);
    const data = response.status === 204 ? null : await response.json().catch(() => null);
    if (!response.ok) {
      if (response.status === 401 && current().owner === owner) onUnauthorized();
      throw new ApiError(data?.error || `请求失败（${response.status}）`, response.status, data?.retryAt);
    }
    return data;
  }

  api.get = (path) => api(path);
  api.post = (path, body = {}, headers) => api(path, { method: 'POST', body, headers });
  api.put = (path, body) => api(path, { method: 'PUT', body });
  api.patch = (path, body) => api(path, { method: 'PATCH', body });
  api.del = (path, body) => api(path, { method: 'DELETE', body });
  api.token = currentToken;
  api.draftOwner = () => current().owner;
  api.setToken = (value) => { credential = remember(value.trim(), current()); };
  api.onUnauthorized = (fn) => { onUnauthorized = fn; };
  return api;
}
