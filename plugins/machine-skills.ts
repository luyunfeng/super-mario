import { constants } from 'node:fs';
import { lstat, open, opendir, realpath, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { isMap, parseDocument } from 'yaml';
import type { JsonObject } from '../packages/plugin-sdk/src/index.ts';

type Options = { codexHome?: string; claudeHome?: string; home?: string };
type Source = 'codex' | 'claude-code' | 'shared';
type Skill = { name: string; description: string; source: Source };
const headerBytes = 16 * 1024;
const maxCatalogBytes = 768 * 1024;
const decoder = new TextDecoder('utf-8', { fatal: true });
const code = (error: unknown) => (error as NodeJS.ErrnoException)?.code;

function profile(path: string): string {
  if (!isAbsolute(path) || resolve(path) === sep || /\p{Cc}/u.test(path)) throw new Error('技能配置目录须为绝对目录');
  return resolve(path, 'skills');
}

// Only immediate skill manifests inside a configured skills root may be read.
// Links into another configured root are common with shared agent skills.
function withinRoots(file: string, roots: string[]): boolean {
  return roots.some(root => {
    const parts = relative(root, file).split(sep);
    return parts.length === 2 && parts[0] && !parts[0].startsWith('.') && parts[1] === 'SKILL.md';
  });
}

function metadata(bytes: Buffer, complete: boolean, fallback: string, source: Source): Skill | undefined {
  // Inspect ASCII delimiters first so trailing body bytes never enter the YAML decoder.
  let start = 0, headerStart = 0;
  while (start < bytes.length) {
    const newline = bytes.indexOf(10, start);
    const end = newline < 0 ? bytes.length : newline;
    const delimiter = (newline >= 0 || complete) && bytes.subarray(start, end).toString('utf8').trim() === '---';
    if (start === 0) {
      if (!delimiter) return;
      headerStart = end + 1;
    } else if (delimiter) {
      const doc = parseDocument(decoder.decode(bytes.subarray(headerStart, start)), { uniqueKeys: true });
      if (doc.errors.length || doc.warnings.length || !isMap(doc.contents)) throw new Error('技能元数据不是有效的 YAML 映射');
      // Read only concrete scalars. Do not resolve aliases, substitutions or commands.
      const enabled = doc.get('user-invocable');
      if (doc.has('user-invocable') && enabled !== true && enabled !== 'true') return;
      const label = doc.get('name'), summary = doc.get('description');
      if ((label != null && typeof label !== 'string') || (summary != null && typeof summary !== 'string'))
        throw new Error('技能名称和说明须为文本');
      const name = (label || fallback).trim();
      if (!name || Array.from(name).length > 128 || /[\p{Cc}\p{Cs}\p{Bidi_Control}]/u.test(name)) throw new Error('技能名称无效');
      const description = Array.from((summary ?? '').replace(/\s+/gu, ' ').trim()).slice(0, 512).join('');
      return { name, description, source };
    }
    start = end + 1;
  }
  if (headerStart) throw new Error('技能元数据缺少结束标记或超过 16 KiB');
}

async function readSkill(file: string, roots: string[], seen: Set<string>, fallback: string, source: Source) {
  let handle;
  try {
    const target = await realpath(file);
    if (!withinRoots(target, roots)) return;
    const before = await lstat(target);
    if (!before.isFile()) return;
    handle = await open(target, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const info = await handle.stat();
    if (!info.isFile() || before.ino !== info.ino || before.dev !== info.dev) return;
    const current = await realpath(process.platform === 'linux' ? '/proc/self/fd/' + handle.fd : target);
    if (current !== target || !withinRoots(current, roots)) return;
    const identity = info.dev + ':' + info.ino;
    if (seen.has(identity)) return;
    seen.add(identity);
    const buffer = Buffer.alloc(Math.min(headerBytes, info.size));
    let count = 0;
    while (count < buffer.length) {
      const { bytesRead } = await handle.read(buffer, count, buffer.length - count, count);
      if (!bytesRead) break;
      count += bytesRead;
    }
    return metadata(buffer.subarray(0, count), count >= info.size, fallback, source);
  } catch (error) {
    if (['ENOENT', 'ENOTDIR', 'ELOOP'].includes(code(error) ?? '')) return;
    throw error;
  } finally { await handle?.close(); }
}

export function createMachineSkills(options: Options = {}) {
  async function catalog(params: JsonObject) {
    if (!params || typeof params !== 'object' || Array.isArray(params) || Object.keys(params).length)
      throw new Error('技能目录查询不接受路径或其他参数');
    // This optional capability validates its profile configuration only when requested.
    const home = options.home ?? homedir();
    const configured: [Source, string][] = [
      ['codex', profile(options.codexHome ?? (process.env.CODEX_HOME || join(home, '.codex')))],
      ['claude-code', profile(options.claudeHome ?? (process.env.CLAUDE_CONFIG_DIR || join(home, '.claude')))],
      ['shared', profile(join(home, '.agents'))],
    ];
    const roots = new Map<string, Source>();
    for (const [source, path] of configured) {
      try {
        const root = await realpath(path);
        if (root === sep || !(await stat(root)).isDirectory()) throw new Error('技能根路径无效');
        if (!roots.has(root)) roots.set(root, source);
      } catch (error) {
        if (code(error) !== 'ENOENT') throw new Error(source + ' 技能目录无法读取', { cause: error });
      }
    }
    const skills: Skill[] = [], seen = new Set<string>(), allowed = [...roots.keys()];
    let inspected = 0, truncated = false;
    // Count the JSON bytes after escaping. The remaining WebSocket capacity is for the RPC envelope.
    let encodedBytes = Buffer.byteLength(JSON.stringify({ skills: [], truncated: false }));
    for (const [root, source] of roots) {
      try {
        const directory = await opendir(root);
        const names: string[] = [];
        for await (const entry of directory) {
          if (++inspected > 2048) { truncated = true; break; }
          if (!entry.name.startsWith('.') && (entry.isDirectory() || entry.isSymbolicLink())) names.push(entry.name);
        }
        for (const name of names.sort()) {
          const skill = await readSkill(join(root, name, 'SKILL.md'), allowed, seen, name, source);
          if (!skill) continue;
          const additionalBytes = Buffer.byteLength(JSON.stringify(skill)) + (skills.length ? 1 : 0);
          if (skills.length === 512 || encodedBytes + additionalBytes > maxCatalogBytes) return { skills, truncated: true };
          encodedBytes += additionalBytes;
          skills.push(skill);
        }
        if (truncated) break;
      } catch (error) {
        throw new Error(source + ' 技能目录或 SKILL.md 元数据无法读取', { cause: error });
      }
    }
    return { skills, truncated };
  }
  return { handlers: { 'skills.catalog': catalog } };
}
