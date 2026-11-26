// Reading what a server on this computer is showing, for the preview panel. The owner or an
// assistant starts the server in a terminal; this only reads it, and only on this computer's
// own loopback. Nothing is sent anywhere else.
//
// It is one page at a time. The page in the browser cannot be proxied through here yet: its own
// requests for scripts and styles would each be one of these reads, and a page that makes
// requests of its own would not work. What this gives is whether the server answers, and what
// its first page says.
import type { Json, NodeHandler } from '../../../packages/plugin-sdk/src/index.ts';

/** The most one answer is read to, and the most that is returned. */
const most = 512 * 1024;

export interface PreviewPage {
  at: string;
  port: number;
  path: string;
  ok: boolean;
  status: number;
  /** The content type as the server gave it, without parameters. */
  type: string;
  /** The page as text, when it is text; cut at the limit. */
  text?: string;
  /** How long the answer took. */
  ms: number;
  error?: string;
}

/** Whether a port is one a person would name for a server of their own. */
export function validPort(port: unknown): port is number {
  return typeof port === 'number' && Number.isSafeInteger(port) && port >= 1 && port <= 65535;
}

/** A path on that server: relative, with a query, and nothing that could reach another host. */
export function validPath(path: unknown): path is string {
  return typeof path === 'string' && path.length <= 2048 && !/[\0\r\n]/.test(path) && !path.startsWith('//') && !/^[a-z][a-z0-9+.-]*:/i.test(path);
}

/** Reads one page from a server on this computer's loopback. */
export async function readPreview(port: unknown, path: unknown = '/', options: { fetch?: typeof fetch; now?: () => number; timeoutMs?: number } = {}): Promise<PreviewPage> {
  const number = port;
  if (!validPort(number)) throw new Error('端口无效');
  const route = path;
  if (!validPath(route)) throw new Error('路径无效');
  const now = options.now ?? Date.now;
  const started = now();
    const target = 'http://127.0.0.1:' + number + (route.startsWith('/') ? route : '/' + route);
  try {
    // The request is made to the loopback only, and follows no redirect: a redirect could send
    // it to another computer.
    const response = await (options.fetch ?? fetch)(target, { redirect: 'manual', signal: AbortSignal.timeout(options.timeoutMs ?? 5000), headers: { accept: 'text/html, text/plain;q=0.9, */*;q=0.1' } });
    const type = (response.headers.get('content-type') ?? '').split(';')[0]!.trim().toLowerCase();
    const page: PreviewPage = { at: new Date(started).toISOString(), port: number, path: route, ok: response.ok, status: response.status, type, ms: Math.max(0, now() - started) };
    // A redirect is reported as one and not followed. The owner is told where it would go.
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get('location');
      return { ...page, error: '这个地址会跳转到 ' + (location ? location.slice(0, 200) : '别处') + '，请在地址栏里打开跳转后的地址。' };
    }
    if (type.startsWith('text/') || type === 'application/json' || type === '' || type === 'application/xml' || type === 'image/svg+xml') {
      const text = await response.text();
      return { ...page, text: text.slice(0, most), ...(text.length > most ? { error: '页面超过 512 KiB，只显示开头。' } : {}) };
    }
    return { ...page, error: '这是 ' + (type || '未知类型') + '，预览只显示文字内容。' };
  } catch (error) {
    return { at: new Date(started).toISOString(), port: number, path: route, ok: false, status: 0, type: '', ms: Math.max(0, now() - started),
      error: (error instanceof Error ? error.message : String(error)).includes('timed out') ? '这个端口 5 秒内没有回应，可能服务还没起来。' : '这个端口没有在运行的服务。' };
  }
}

export function createWorkspacePreviewNode(options: { fetch?: typeof fetch; now?: () => number } = {}) {
  const handlers: Record<string, NodeHandler> = {
    'workspace.preview.read': async params => {
      if (!params || Object.keys(params).some(key => !['port', 'path'].includes(key))) throw new Error('读取预览只接受 port 和 path');
      if (!validPort(params.port)) throw new Error('端口无效');
      if (params.path !== undefined && !validPath(params.path)) throw new Error('路径无效');
      return await readPreview(params.port, params.path ?? '/', options) as unknown as Json;
    },
  };
  return { handlers };
}
