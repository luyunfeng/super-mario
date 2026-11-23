import type { Extension, Json } from '../packages/plugin-sdk/src/index.ts';

const service = 'release-source.releases';
const bytesLimit = 2 * 1024 * 1024;

type ReadCode = 'invalid_resource'|'not_found'|'rate_limited'|'forbidden'|'unavailable';
function error(status: number, message: string, sourceReadCode: ReadCode = 'unavailable', retryAfterSeconds?: number): never {
  throw Object.assign(new Error(message), {status, sourceReadCode, ...(retryAfterSeconds !== undefined && {retryAfterSeconds})});
}

function rateLimitDelay(headers: Headers): number | undefined {
  const now = Date.now();
  const retry = headers.get('retry-after')?.trim() ?? '';
  if (/^\d+$/.test(retry)) {
    const seconds = Number(retry);
    if (Number.isSafeInteger(seconds) && seconds > 0) return seconds;
  } else {
    // GitHub's HTTP-date uses IMF-fixdate. Round-trip the canonical form so that
    // Date.parse's non-HTTP inputs and impossible calendar dates cannot cause a delay.
    const at = Date.parse(retry);
    if (at > now && new Date(at).toUTCString() === retry) return Math.ceil((at - now) / 1000);
  }
  const reset = headers.get('x-ratelimit-reset')?.trim() ?? '';
  if (!/^\d+$/.test(reset)) return;
  const at = new Date(Number(reset) * 1000).getTime();
  if (at > now) return Math.ceil((at - now) / 1000);
}

function releasePage(input: Json) {
  if (input && typeof input === 'object' && !Array.isArray(input) && typeof input.resource === 'string') {
    const resource = input.resource.trim();
    const parts = /^([a-z0-9][a-z0-9_-]{0,38})\/([a-z0-9._-]{1,100})$/i.exec(resource);
    if (parts && parts[2] !== '.' && parts[2] !== '..') {
      const checkpoint=input.checkpoint;
      if (checkpoint !== undefined && (typeof checkpoint!=='string' || !/^[1-9]\d*$/.test(checkpoint) || !Number.isSafeInteger(Number(checkpoint))))
        return error(400,'GitHub 版本发布检查点无效。','invalid_resource');
      if (input.cursor === undefined) return {resource,page:1,checkpoint};
      if (typeof input.cursor !== 'string' || !/^[1-9]\d*$/.test(input.cursor) ||
          Number(input.cursor) < 2 || !Number.isSafeInteger(Number(input.cursor)))
        return error(400, 'GitHub 版本分页游标无效。','invalid_resource');
      return {resource,page:Number(input.cursor),checkpoint};
    }
  }
  return error(400, '请填写公开 GitHub 仓库，格式为 owner/repo。','invalid_resource');
}

// GitHub supplies page links as <URI>; rel="next". Treat the URI as opaque:
// numeric cursors are ours, and every outgoing URL is built from the repository.
function hasNextPage(header: string) {
  const link = /\s*<[^<>]*>((?:\s*;\s*[\w-]+\s*=\s*(?:"(?:\\.|[^"\\])*"|[^;,"\s]+))*)\s*(?:,|$)/gy;
  for (;;) {
    const entry=link.exec(header);
    if (!entry) return false;
    for (const param of entry[1].matchAll(/;\s*([\w-]+)\s*=\s*(?:"((?:\\.|[^"\\])*)"|([^;,"\s]+))/g)) {
      if (param[1].toLowerCase()==='rel' && (param[2] ?? param[3]).toLowerCase().split(/\s+/).includes('next')) return true;
    }
  }
}

function excerpt(value: string, max: number) {
  if (value.length <= max) return value;
  const chars = Array.from(value);
  return chars.length <= max ? value : chars.slice(0, max - 1).join('') + '…';
}

async function releaseItems(response: Response, resource: string, signal: AbortSignal) {
  if (Number(response.headers.get('content-length')) > bytesLimit) {
    await response.body?.cancel();
    error(502, 'GitHub 版本响应超过 2 MiB。');
  }
  const reader = response.body?.getReader();
  if (!reader) return error(502, 'GitHub 未返回版本列表。');
  const chunks: Uint8Array[] = [];
  let length = 0;
  const cancel = () => { void reader.cancel().catch(() => {}); };
  signal.addEventListener('abort', cancel, { once:true });
  try {
    signal.throwIfAborted();
    for (;;) {
      const {value, done} = await reader.read();
      signal.throwIfAborted();
      if (done) break;
      length += value.byteLength;
      if (length > bytesLimit) { await reader.cancel(); error(502, 'GitHub 版本响应超过 2 MiB。'); }
      chunks.push(value);
    }
  } finally {
    signal.removeEventListener('abort', cancel);
    reader.releaseLock();
  }
  let rows: unknown;
  try { rows = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { return error(502, 'GitHub 版本列表不是有效的 JSON。'); }
  if (!Array.isArray(rows)) return error(502, 'GitHub 版本列表格式无效。');
  if (rows.length > 30) return error(502, 'GitHub 版本列表超出本次请求的 30 项。');
  const items = [];
  for (const row of rows) {
    if (row?.draft === true) continue;
    if (!row || !Number.isSafeInteger(row.id) || row.id <= 0 || typeof row.tag_name !== 'string' || !row.tag_name.trim() ||
      (row.name != null && typeof row.name !== 'string') || (row.body != null && typeof row.body !== 'string')) {
      return error(502, 'GitHub 版本记录缺少有效的发布编号、标签或说明。');
    }
    const title: string = row.name?.trim() || row.tag_name;
    // Construct the link from validated identity. Release notes and API-provided links are untrusted data.
    const url = 'https://github.com/' + resource + '/releases/tag/' + encodeURIComponent(row.tag_name);
    items.push({id:String(row.id), title:excerpt(title,512), text:excerpt(row.body?.trim() || row.tag_name,16000),
      ...(url.length <= 4096 && {url})});
  }
  return {items};
}

export function createReleaseSourceExtension(options: {fetch?: typeof fetch; timeoutMs?: number} = {}): Extension {
  return {
    id:'release-source', name:'GitHub 版本发布', capabilities:['subscription.source'],
    permissions:['contribute:connectors','service.provide:' + service],
    activate(context) {
      const lifetime = new AbortController();
      context.defer(() => lifetime.abort());
      context.contribute('connectors', 'releases', {kind:'subscription-source', name:'GitHub 版本发布', resourceLabel:'仓库（owner/repo）', service});
      context.contribute('services', 'releases', {name:service, version:1, readOnly:true, async handler(input, request) {
        const {resource,page,checkpoint} = releasePage(input);
        const signal = AbortSignal.any([request, lifetime.signal, AbortSignal.timeout(options.timeoutMs ?? 10_000)]);
        signal.throwIfAborted();
        try {
          const response = await (options.fetch ?? fetch)('https://api.github.com/repos/' + resource + '/releases?per_page=30' + (page === 1 ? '' : '&page=' + page), {
            method:'GET', headers:{accept:'application/vnd.github+json','user-agent':'super-mario-release-source'},
            credentials:'omit', redirect:'error', signal,
          });
          if (!response.ok) {
            await response.body?.cancel();
            if (response.status === 404) error(404, '找不到公开 GitHub 仓库，请核对 owner/repo。','not_found');
            if (response.status === 429 || (response.status === 403 && (response.headers.has('retry-after') || response.headers.get('x-ratelimit-remaining') === '0')))
              error(429, 'GitHub API 已限流，请稍后再试。','rate_limited',rateLimitDelay(response.headers));
            if (response.status === 403) error(403, 'GitHub 拒绝读取该仓库的版本。','forbidden');
            error(502, 'GitHub 读取版本失败，HTTP ' + response.status + '。');
          }
          const {items} = await releaseItems(response, resource, signal);
          const frontier:Record<string,string> = page === 1 && items.length ? {checkpoint:items[0].id} : {};
          const stop = checkpoint === undefined ? -1 : items.findIndex(item => item.id === checkpoint);
          if (stop >= 0) return {items:items.slice(0,stop),...frontier};
          if (!hasNextPage(response.headers.get('link') ?? '')) return {items,...frontier};
          if (!Number.isSafeInteger(page + 1)) error(502,'GitHub 版本页码超出可读取范围。');
          return {items,...frontier,nextCursor:String(page + 1)};
        } catch (cause) {
          if (signal.aborted) {
            if (signal.reason?.name === 'TimeoutError') error(504, '读取 GitHub 版本超时。');
            signal.throwIfAborted();
          }
          if (cause instanceof Error && 'status' in cause) throw cause;
          error(502, '无法连接 GitHub 版本 API。');
        }
      }});
    },
  };
}
