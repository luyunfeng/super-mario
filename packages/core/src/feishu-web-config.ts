import { randomUUID } from 'node:crypto';
import { closeSync, constants, fstatSync, openSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { AppConfig } from '../../protocol/src/index.ts';

const defaultOrigin = 'http://127.0.0.1:4310';
function invalid(message: string): never { throw Object.assign(new Error(message), { status: 400 }); }

function origin(value: unknown) {
  if (typeof value !== 'string' || !/^https?:\/\/[^/?#@\\\s]+\/?$/i.test(value)) {
    invalid('请输入完整的 HTTP 或 HTTPS 网关根地址，不含凭证、路径、查询或片段');
  }
  let url: URL;
  try { url = new URL(value); } catch { return invalid('网页网关地址无效'); }
  const local = url.hostname === 'localhost' || url.hostname === '[::1]' || /^127(?:\.\d+){3}$/.test(url.hostname);
  if (url.protocol === 'http:' && !local) invalid('非回环网关必须使用 HTTPS');
  return url.origin;
}
function credential(value: unknown) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9._~-]{0,8192}$/.test(value)) invalid('网页访问令牌格式无效');
  return value;
}

export function createFeishuWebConfig(dataDir: string, initial?: AppConfig['feishuWeb']) {
  const file = join(dataDir, 'feishu-web.json');
  function load() {
    let fd: number;
    try { fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new Error('无法读取网页网关私有配置');
      const fallback = initial ?? { baseUrl: process.env.SUPER_MARIO_FEISHU_WEB_BASE_URL, token: process.env.SUPER_MARIO_FEISHU_WEB_TOKEN };
      return { baseUrl: origin(fallback.baseUrl || defaultOrigin), token: credential(fallback.token ?? '') };
    }
    try {
      const stat = fstatSync(fd);
      if (!stat.isFile() || stat.size > 32768 || (stat.mode & 0o077) || (process.getuid && stat.uid !== process.getuid())) {
        throw new Error('网页网关配置需要当前用户的私有文件');
      }
      const saved = JSON.parse(readFileSync(fd, 'utf8'));
      if (!saved.token) throw new Error('缺少网页访问令牌');
      return { baseUrl: origin(saved.baseUrl), token: credential(saved.token) };
    } catch { throw new Error('网页网关私有配置不可用，请检查文件权限和格式'); }
    finally { closeSync(fd); }
  }
  let issue: string | undefined;
  let current: { baseUrl: string; token: string };
  try { current = load(); }
  catch {
    // Keep a broken optional source offline. Never combine fallback credentials
    // with a replacement address when the saved binding cannot be verified.
    current = { baseUrl: defaultOrigin, token: '' };
    issue = '网页网关配置不可用，请重新填写地址和令牌';
  }
  return {
    read: () => ({ ...current }),
    error: () => issue,
    public: () => ({ baseUrl: current.baseUrl, hasToken: Boolean(current.token) }),
    save(input: Record<string, unknown>) {
      if (!input || typeof input !== 'object' || Array.isArray(input)) invalid('网页网关配置必须为对象');
      const baseUrl = input.baseUrl === undefined ? current.baseUrl : origin(input.baseUrl);
      const supplied = input.token === undefined ? '' : credential(input.token);
      const token = supplied || (baseUrl === current.baseUrl ? current.token : '');
      if (!token) invalid('首次配置或更换网关地址时必须填写该网关的令牌');
      const next = { baseUrl, token };
      const temp = file + '.' + randomUUID() + '.tmp';
      try {
        writeFileSync(temp, JSON.stringify(next), { flag: 'wx', mode: 0o600 });
        renameSync(temp, file);
      } finally { rmSync(temp, { force: true }); }
      const changed = baseUrl !== current.baseUrl || token !== current.token;
      current = next;
      issue = undefined;
      return changed;
    },
  };
}
