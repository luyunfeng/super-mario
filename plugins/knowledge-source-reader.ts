import { execFile } from 'node:child_process';
import { constants } from 'node:fs';
import { lstat, mkdtemp, open, realpath, rmdir, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { PluginService } from '../packages/plugin-sdk/src/index.ts';
import { extractKnowledgeAttachment, supportsKnowledgeAttachment, KnowledgeAttachmentError } from './knowledge-attachment-parser.ts';
import { hasKnowledgeSourceHTML, type KnowledgeSourceErrorCode, type KnowledgeSourceReader, type KnowledgeSourceReaderOptions, type KnowledgeSourceResult, type KnowledgeSourceRunCLI } from '../packages/protocol/src/index.ts';
export { hasKnowledgeSourceHTML };

const MAX_BYTES = 1024 * 1024;
const TIMEOUT_MS = 30_000;
const TOKEN = /^[A-Za-z0-9_-]{1,256}$/;
const messages: Record<KnowledgeSourceErrorCode, string> = {
  MISSING_PROFILE: '请明确配置飞书读取 profile；不会使用默认账号',
  INVALID_CONFIG: '知识来源读取配置无效', INVALID_URL: '受保护来源必须是有效的 HTTPS 云文档链接',
  UNTRUSTED_HOST: '云文档域名未在受信白名单中', CROSS_ORIGIN: '拒绝跨域或不匹配的来源链接',
  UNAUTHORIZED: '所选 profile 未授权、缺少 scope 或没有来源访问权限；请由用户配置',
  CLI_UNAVAILABLE: '未找到可用的 lark-cli', CLI_FAILED: '飞书只读命令失败，请检查所选 profile 和 CLI 配置',
  INVALID_RESPONSE: '飞书只读命令未返回有效正文数据', UNSUPPORTED: '不支持此来源或附件格式；支持 UTF-8 文本、PDF文字层和DOCX',
  EMPTY_SOURCE: '来源没有可读正文', LIMIT_EXCEEDED: '来源超过 1 MiB 读取限制',
  CANCELLED: '来源读取已取消', TIMEOUT: '来源读取超时', UNSAFE_FILE: '拒绝不安全的临时附件路径或文件',
};

export class KnowledgeSourceReaderError extends Error {
  readonly code: KnowledgeSourceErrorCode;
  constructor(code: KnowledgeSourceErrorCode) { super(messages[code]); this.name = 'KnowledgeSourceReaderError'; this.code = code; }
}
function fail(code: KnowledgeSourceErrorCode): never { throw new KnowledgeSourceReaderError(code); }
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail('INVALID_RESPONSE');
  return value as Record<string, unknown>;
}
function json(value: string): Record<string, unknown> {
  try { return object(JSON.parse(value)); } catch { return fail('INVALID_RESPONSE'); }
}
function token(value: unknown): string {
  if (typeof value !== 'string' || !TOKEN.test(value)) fail('INVALID_RESPONSE');
  return value;
}
/** Only classification fields are inspected. Never retain stderr, argv, profile or an error cause. */
function cliFailure(stderr = ''): never {
  let error: Record<string, unknown> = {};
  try { error = object(json(stderr).error); } catch { /* Non-JSON diagnostics remain private. */ }
  if (['authentication', 'authorization'].includes(String(error.type)) ||
      ['missing_scope', 'permission_denied', 'not_logged_in', 'token_expired', 'unauthorized'].includes(String(error.subtype)) ||
      [99991661, 99991663, 99991668, 99991671, 99991672, 99991677, 99991679, 99991680, 970003].includes(Number(error.code))) fail('UNAUTHORIZED');
  fail('CLI_FAILED');
}

const executeCLI: KnowledgeSourceRunCLI = (argv, options) => new Promise((resolve, reject) => {
  // No shell; stdin closed; timeout escalates directly to SIGKILL. CLI errors never escape.
  let stopped: Promise<void>;
  const child = execFile('lark-cli', [...argv], {
    cwd: options.cwd, signal: options.signal, timeout: options.timeoutMs,
    maxBuffer: options.maxOutputBytes, encoding: 'utf8', killSignal: 'SIGKILL', windowsHide: true,
  }, (error, stdout, stderr) => {
    // execFile may invoke its callback on AbortError before the child closes.
    // Wait for close before letting read() remove the download directory.
    void stopped.then(() => {
      if (!error) { resolve({ stdout, stderr, exitCode: 0 }); return; }
      if (options.signal.aborted) { reject(new KnowledgeSourceReaderError('CANCELLED')); return; }
      if (error.code === 'ENOENT') { reject(new KnowledgeSourceReaderError('CLI_UNAVAILABLE')); return; }
      if (error.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') { reject(new KnowledgeSourceReaderError('LIMIT_EXCEEDED')); return; }
      if (error.killed) { reject(new KnowledgeSourceReaderError('TIMEOUT')); return; }
      resolve({ stdout, stderr, exitCode: typeof error.code === 'number' ? error.code : 1 });
    });
  });
  stopped = new Promise(done => { child.once('close', () => done()); });
  child.stdin?.end();
});

/** One tenant label under an official suffix, or an exact host configured by the user.
 * Classification deliberately accepts invalid schemes/ports: read() must reject them
 * instead of allowing a host to fall back to unauthenticated public fetch.
 */
export function isProtectedKnowledgeURL(input: string, trustedHosts: readonly string[] = []): boolean {
  if (typeof input !== 'string') return false;
  const protectedHost = (host: string, path: string) => {
    if (trustedHosts.some(value => value.toLowerCase() === host)) return true;
    const official = /^([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)\.(?:feishu\.cn|larksuite\.com|larkoffice\.com)$/.exec(host);
    if (!official) return false;
    // Public product/developer sites also share the official suffix. Only their
    // cloud resource paths require authenticated reading; tenants stay fail closed.
    return !['open', 'www'].includes(official[1]!) || /^\/(?:docx|wiki|file|drive\/file)(?:\/|$)/i.test(path);
  };
  try {
    const url = new URL(input);
    return protectedHost(url.hostname.toLowerCase().replace(/\.$/, ''), url.pathname);
  } catch { /* Invalid ports still need host classification. */ }
  const match = /^[a-z][a-z0-9+.-]*:\/\/([^/?#\\\s]*)([^?#]*)/i.exec(input);
  if (!match) return false;
  const authority = match[1]!;
  const host = authority.slice(authority.lastIndexOf('@') + 1).split(':', 1)[0]!.toLowerCase().replace(/\.$/, '');
  return protectedHost(host, match[2]!);
}

/** Fixed CLI recipes verified with local lark-cli help and embedded read-only skills.
 * URL input never reaches CLI: +inspect accepts a bare token with --type; +fetch
 * and +download also accept tokens. No URL fetching, login, auth, scope grants or retries.
 */
export function createKnowledgeSourceReader(options: KnowledgeSourceReaderOptions = {}): KnowledgeSourceReader {
  const profile = options.profile;
  const hosts = new Set<string>();
  for (const host of options.trustedHosts ?? []) {
    if (!/^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}$/i.test(host) || host.length > 253) fail('INVALID_CONFIG');
    hosts.add(host.toLowerCase());
  }
  if (profile !== undefined && (typeof profile !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(profile))) fail('INVALID_CONFIG');
  const runCLI = options.runCLI ?? executeCLI;
  const handles = (url: string) => isProtectedKnowledgeURL(url, [...hosts]);

  function parseURL(input: string) {
    if (typeof input !== 'string' || input.length > 4096 || /[\s\\\u0000-\u001f\u007f]/.test(input)) fail('INVALID_URL');
    let url: URL;
    try { url = new URL(input); } catch { return fail('INVALID_URL'); }
    if (url.protocol !== 'https:' || url.username || url.password || url.port || url.hostname.endsWith('.') || !input.startsWith('https://')) fail('INVALID_URL');
    if (!handles(input)) fail('UNTRUSTED_HOST');
    const path = /^\/(docx|wiki|file|drive\/file)\/([A-Za-z0-9_-]{1,256})\/?$/.exec(url.pathname);
    // Disallow URL normalization tricks as well as encoded separators and dot segments.
    const rawPath = input.slice(input.indexOf('/', 8)).split(/[?#]/, 1)[0];
    if (!path || rawPath !== url.pathname) fail('INVALID_URL');
    return { url, type: path[1] === 'drive/file' ? 'file' : path[1], token: path[2], source: `${url.origin}${url.pathname}` };
  }

  async function read(input: string, request: { signal?: AbortSignal } = {}): Promise<KnowledgeSourceResult> {
    const source = parseURL(input);
    if (!profile) fail('MISSING_PROFILE');
    if (request.signal?.aborted) fail('CANCELLED');
    const controller = new AbortController();
    let timedOut = false, fileTooLarge = false;
    const cancel = () => controller.abort();
    request.signal?.addEventListener('abort', cancel, { once: true });
    const deadline = setTimeout(() => { timedOut = true; controller.abort(); }, TIMEOUT_MS);
    let directory: string | undefined;
    let watcher: NodeJS.Timeout | undefined;
    // The trusted runner must settle after its child exits on signal; cleanup must
    // never race a live download. The production runner uses execFile's signal.
    async function invoke(args: string[]): Promise<Record<string, unknown>> {
      if (controller.signal.aborted) fail('CANCELLED');
      const argv = [...args, '--as', 'user', '--profile', profile!, '--format', 'json'];
      const result = await runCLI(argv, { cwd: directory!, signal: controller.signal, timeoutMs: TIMEOUT_MS, maxOutputBytes: MAX_BYTES });
      if (controller.signal.aborted) fail('CANCELLED');
      if (Buffer.byteLength(result.stdout) > MAX_BYTES || Buffer.byteLength(result.stderr ?? '') > MAX_BYTES) fail('LIMIT_EXCEEDED');
      if (result.exitCode !== 0) cliFailure(result.stderr);
      const envelope = json(result.stdout);
      if (envelope.ok !== true) cliFailure(result.stdout);
      if (envelope.identity !== 'user') fail('INVALID_RESPONSE');
      return object(envelope.data);
    }
    try {
      directory = await mkdtemp(join(tmpdir(), 'super-mario-knowledge-source-'));
      const metadata = await invoke(['drive', '+inspect', '--url', source.token, '--type', source.type]);
      const type = metadata.type;
      if (type !== 'docx' && type !== 'file') fail('UNSUPPORTED');
      const id = token(metadata.token);
      if (source.type !== 'wiki' && (id !== source.token || type !== source.type)) fail('INVALID_RESPONSE');
      if (source.type === 'wiki') {
        const node = object(metadata.wiki_node);
        if (node.node_token !== source.token || node.obj_token !== id || node.obj_type !== type) fail('INVALID_RESPONSE');
      }
      let canonical = `${source.url.origin}/${type}/${id}`;
      if (metadata.url !== undefined) {
        if (typeof metadata.url !== 'string') fail('INVALID_RESPONSE');
        let resolved: ReturnType<typeof parseURL>;
        try { resolved = parseURL(metadata.url); } catch { return fail('CROSS_ORIGIN'); }
        if (resolved.url.origin !== source.url.origin || resolved.type !== type || resolved.token !== id) fail('CROSS_ORIGIN');
        canonical = resolved.source;
      }
      if (typeof metadata.title !== 'string' || metadata.title.length > 4096) fail('INVALID_RESPONSE');
      const title = metadata.title.trim() || id;
      let text: string;
      if (type === 'docx') {
        const data = await invoke(['docs', '+fetch', '--doc', id, '--doc-format', 'markdown', '--detail', 'simple']);
        const document = object(data.document);
        if (document.document_id !== id || typeof document.content !== 'string') fail('INVALID_RESPONSE');
        text = document.content;
      } else {
        // Fail closed before downloading unknown formats. Never infer text from a CLI
        // success envelope, a returned filename, or a binary's lossy UTF-8 decoding.
        const binary = supportsKnowledgeAttachment(title);
        if (!binary && !/\.(txt|md|markdown|csv|tsv|json|jsonl|log|yaml|yml|xml)$/i.test(title)) fail('UNSUPPORTED');
        const target = join(directory, 'source.txt');
        const handle = await open(target, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
        await handle.close();
        watcher = setInterval(() => {
          void lstat(target).then(info => {
            if (info.size > MAX_BYTES) { fileTooLarge = true; controller.abort(); }
          }).catch(() => {});
        }, 25);
        await invoke(['drive', '+download', '--file-token', id, '--output', './source.txt', '--overwrite']);
        clearInterval(watcher); watcher = undefined;
        const info = await lstat(target);
        if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || await realpath(target) !== target) fail('UNSAFE_FILE');
        if (info.size > MAX_BYTES) fail('LIMIT_EXCEEDED');
        // O_NOFOLLOW closes the final-component symlink race. Read at most LIMIT+1,
        // even if a concurrently changed file no longer matches its earlier stat.
        const file = await open(target, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
        try {
          const current = await file.stat();
          if (!current.isFile() || current.nlink !== 1 || current.ino !== info.ino || current.dev !== info.dev) fail('UNSAFE_FILE');
          const buffer = Buffer.alloc(MAX_BYTES + 1);
          let size = 0;
          while (size < buffer.length) { const part = await file.read(buffer, size, buffer.length - size, null); if (!part.bytesRead) break; size += part.bytesRead; }
          if (size > MAX_BYTES) fail('LIMIT_EXCEEDED');
          if(binary)text=await extractKnowledgeAttachment({bytes:buffer.subarray(0,size),name:title,signal:controller.signal});
          else try { text = new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0, size)); } catch { return fail('UNSUPPORTED'); }
        } finally { await file.close(); }
      }
      if (controller.signal.aborted) fail('CANCELLED');
      if (Buffer.byteLength(text) > MAX_BYTES) fail('LIMIT_EXCEEDED');
      if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(text) || /^(?:%PDF-|PK\x03\x04|\{\\rtf)/.test(text)) fail('UNSUPPORTED');
      // Never accept a login/error HTML page as successful document content.
      if (hasKnowledgeSourceHTML(text)) fail('INVALID_RESPONSE');
      if (!text.trim()) fail('EMPTY_SOURCE');
      return { source: source.source, title, text, format: type === 'docx' ? 'markdown' : 'text', trust: 'untrusted', references: [{ url: canonical, title, type, token: id }] };
    } catch (error) {
      if (fileTooLarge) fail('LIMIT_EXCEEDED');
      if (timedOut) fail('TIMEOUT');
      if (request.signal?.aborted) fail('CANCELLED');
      if (error instanceof KnowledgeAttachmentError) fail(error.code);
      if (error instanceof KnowledgeSourceReaderError) throw error;
      // Never leak raw execFile errors (they include argv/profile/stderr).
      return fail('CLI_FAILED');
    } finally {
      clearTimeout(deadline); if (watcher) clearInterval(watcher);
      request.signal?.removeEventListener('abort', cancel);
      if (directory) {
        // Delete only our fixed output, never a CLI-supplied path or recursively
        // follow a replaced directory/symlink. rmdir refuses nonempty directories.
        const info = await lstat(directory).catch(() => undefined);
        if (info?.isDirectory() && !info.isSymbolicLink() && await realpath(directory).catch(() => undefined) === directory) {
          await unlink(join(directory, 'source.txt')).catch(() => {});
          await rmdir(directory).catch(() => {});
        }
      }
    }
  }
  return { status: () => ({ state: profile ? 'configured' : 'missing_config', authorization: 'unchecked' }), handles, read };
}

/** Host contributes this service through the existing SDK. Config stays outside JSON input. */
export function createKnowledgeSourceReaderService(reader: KnowledgeSourceReader): PluginService {
  return {
    name: 'knowledge-local.source.read', version: 1,
    async handler(input, signal) {
      if (!input || typeof input !== 'object' || Array.isArray(input) || typeof input.url !== 'string' || Object.keys(input).some(key => key !== 'url')) fail('INVALID_URL');
      const result = await reader.read(input.url, { signal });
      return { ...result, references: result.references.map(reference => ({ ...reference })) };
    },
  };
}
