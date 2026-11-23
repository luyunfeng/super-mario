import type { Extension, Json, JsonObject } from '../packages/plugin-sdk/src/index.ts';

const service = 'release-source.releases';
const repositoryService = 'release-source.repository';
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

function repository(input: Json) {
  if (input && typeof input === 'object' && !Array.isArray(input) && typeof input.resource === 'string') {
    const resource = input.resource.trim();
    const parts = /^([a-z0-9][a-z0-9_-]{0,38})\/([a-z0-9._-]{1,100})$/i.exec(resource);
    if (parts && parts[2] !== '.' && parts[2] !== '..') return {input,resource};
  }
  return error(400, '请填写公开 GitHub 仓库，格式为 owner/repo。','invalid_resource');
}

function releasePage(input: JsonObject) {
  const checkpoint=input.checkpoint;
  if (checkpoint !== undefined && (typeof checkpoint!=='string' || !/^[1-9]\d*$/.test(checkpoint) || !Number.isSafeInteger(Number(checkpoint))))
    return error(400,'GitHub 版本发布检查点无效。','invalid_resource');
  if (input.cursor === undefined) return {page:1,checkpoint};
  if (typeof input.cursor !== 'string' || !/^[1-9]\d*$/.test(input.cursor) ||
      Number(input.cursor) < 2 || !Number.isSafeInteger(Number(input.cursor)))
    return error(400, 'GitHub 版本分页游标无效。','invalid_resource');
  return {page:Number(input.cursor),checkpoint};
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

async function readJson(response: Response, signal: AbortSignal):Promise<unknown> {
  if (Number(response.headers.get('content-length')) > bytesLimit) {
    await response.body?.cancel();
    error(502, 'GitHub 响应超过 2 MiB。');
  }
  const reader = response.body?.getReader();
  if (!reader) return error(502, 'GitHub 未返回响应正文。');
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
      if (length > bytesLimit) { await reader.cancel(); error(502, 'GitHub 响应超过 2 MiB。'); }
      chunks.push(value);
    }
  } finally {
    signal.removeEventListener('abort', cancel);
    reader.releaseLock();
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { return error(502, 'GitHub 响应不是有效的 JSON。'); }
}

function releaseItems(rows:unknown, resource:string) {
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
      ...(typeof row.published_at==='string' && {occurredAt:row.published_at}),
      ...(url.length <= 4096 && {url})});
  }
  return {items};
}

export function createReleaseSourceExtension(options: {fetch?: typeof fetch; timeoutMs?: number} = {}): Extension {
  return {
    id:'release-source', name:'GitHub 版本发布', capabilities:['subscription.source'],
    permissions:['contribute:connectors','service.provide:' + service,'service.provide:' + repositoryService],
    activate(context) {
      const lifetime = new AbortController();
      context.defer(() => lifetime.abort());
      context.contribute('connectors', 'releases', {kind:'subscription-source', name:'GitHub 版本发布', resourceLabel:'仓库（owner/repo）', service});
      context.contribute('connectors','repository',{kind:'subscription-source',mode:'snapshot',name:'GitHub 仓库状态',resourceLabel:'仓库（owner/repo）',service:repositoryService});
      async function requestJson(path:string, request:AbortSignal) {
        const signal = AbortSignal.any([request, lifetime.signal, AbortSignal.timeout(options.timeoutMs ?? 10_000)]);
        signal.throwIfAborted();
        try {
          const response = await (options.fetch ?? fetch)('https://api.github.com/repos/' + path, {
            method:'GET', headers:{accept:'application/vnd.github+json','user-agent':'super-mario-release-source'},
            credentials:'omit', redirect:'error', signal,
          });
          if (!response.ok) {
            await response.body?.cancel();
            if (response.status === 404) error(404, '找不到公开 GitHub 仓库，请核对 owner/repo。','not_found');
            if (response.status === 429 || (response.status === 403 && (response.headers.has('retry-after') || response.headers.get('x-ratelimit-remaining') === '0')))
              error(429, 'GitHub API 已限流，请稍后再试。','rate_limited',rateLimitDelay(response.headers));
            if (response.status === 403) error(403, 'GitHub 拒绝读取该仓库的数据。','forbidden');
            error(502, 'GitHub 读取失败，HTTP ' + response.status + '。');
          }
          return {data:await readJson(response,signal), link: response.headers.get('link') ?? ''};
        } catch (cause) {
          if (signal.aborted) {
            if (signal.reason?.name === 'TimeoutError') error(504, '读取 GitHub 超时。');
            signal.throwIfAborted();
          }
          if (cause instanceof Error && 'status' in cause) throw cause;
          error(502, '无法连接 GitHub API。');
        }
      }
      context.contribute('services', 'releases', {name:service, version:1, readOnly:true, async handler(value, request) {
        const {input,resource}=repository(value);
        const {page,checkpoint}=releasePage(input);
        const {data,link}=await requestJson(resource+'/releases?per_page=30'+(page===1?'':'&page='+page),request);
        const {items} = releaseItems(data,resource);
        const frontier:Record<string,string> = page === 1 && items.length ? {checkpoint:items[0].id} : {};
        const stop = checkpoint === undefined ? -1 : items.findIndex(item => item.id === checkpoint);
        if (stop >= 0) return {items:items.slice(0,stop),...frontier};
        if (!hasNextPage(link)) return {items,...frontier};
        if (!Number.isSafeInteger(page + 1)) error(502,'GitHub 版本页码超出可读取范围。');
        return {items,...frontier,nextCursor:String(page + 1)};
      }});
      context.contribute('services','repository',{name:repositoryService,version:1,readOnly:true,async handler(value,request) {
        const {input,resource}=repository(value);
        if (input.cursor!==undefined || input.checkpoint!==undefined) error(400,'仓库状态快照不接受分页游标或检查点。','invalid_resource');
        const {data}=await requestJson(resource,request);
        const row=data as Record<string,unknown>|null;
        if (!row || row.private===true || typeof row.full_name!=='string' || row.full_name.toLowerCase()!==resource.toLowerCase() ||
            (row.description!==null && typeof row.description!=='string') || typeof row.default_branch!=='string' || !row.default_branch.trim() ||
            typeof row.archived!=='boolean' || typeof row.disabled!=='boolean') {
          error(502,'GitHub 未返回该公开仓库的完整状态。');
        }
        // Only track repository settings; traffic counters and fetch time change on unrelated activity.
        const text=['仓库：'+row.full_name,'描述：'+(row.description===null?'未填写':JSON.stringify(row.description)),
          '默认分支：'+row.default_branch,'已归档：'+(row.archived?'是':'否'),'已禁用：'+(row.disabled?'是':'否')].join('\n');
        return {snapshot:{title:row.full_name+' 仓库状态',text,url:'https://github.com/'+row.full_name}};
      }});
    },
  };
}
