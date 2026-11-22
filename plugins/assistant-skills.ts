import { createHash } from 'node:crypto';
import { crc32 } from 'node:zlib';
import { registerMachineSkillCatalog } from './machine-skill-catalog.ts';
import { officeGuide } from './office/guide.ts';
import { workGuide } from './workbench-work-guide.ts';
import { fromBufferPromise, type ZipFile } from 'yauzl';
import { isAlias, isMap, isNode, isPair, isScalar, parseDocument, visit } from 'yaml';
import type { Extension, ExtensionContext, Json, JsonObject, MachineClient, Store } from '../packages/plugin-sdk/src/index.ts';

const maxArchive = 4 * 1024 * 1024;
const maxExpanded = 16 * 1024 * 1024;
const maxFile = 4 * 1024 * 1024;
const maxManifest = 64 * 1024;
const decoder = new TextDecoder('utf-8', { fatal: true });
type Skill = { name: string; description: string };
type Catalog = { skills: Skill[]; revision: number };
type Loaded = { info: Skill; files: Map<string, Buffer>; digest: string };

function fail(status: number, message: string): never {
  throw Object.assign(new Error(message), { status });
}

const reserved = /^(?:con|prn|aux|nul|clock\$|conin\$|conout\$|(?:lpt|com)[0-9¹²³])(?:\.|$)/i;
function skillName(value: Json | undefined): string {
  if (typeof value !== 'string' || value.length > 64 || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(value) || reserved.test(value))
    fail(400, '技能名称须为小写字母、数字和连字符，最多 64 个字符');
  return value;
}

function filePath(value: Json | undefined): string {
  if (typeof value !== 'string' || Buffer.byteLength(value) > 1024 || /[\\:<>"|?*\p{Cc}\p{Cs}]/u.test(value)) fail(400, '技能文件路径无效');
  const parts = value.split('/');
  if (parts.length > 12 || parts.some(part => !part || part === '.' || part === '..' || /[. ]$/.test(part)
    || Buffer.byteLength(part) > 255 || reserved.test(part))) fail(400, '技能文件路径无效');
  return value;
}

function metadata(bytes: Buffer): Skill {
  if (bytes.length > maxManifest) fail(400, 'SKILL.md 不能超过 64 KiB');
  const lines = decoder.decode(bytes).replaceAll('\r\n', '\n').split('\n');
  const end = lines.indexOf('---', 1);
  if (lines[0] !== '---' || end < 1) fail(400, 'SKILL.md 缺少 YAML 元数据');
  const doc = parseDocument(lines.slice(1, end).join('\n'), { uniqueKeys: true });
  if (doc.errors.length || doc.warnings.length || !isMap(doc.contents)) fail(400, 'SKILL.md 的 YAML 元数据无效');
  visit(doc, (_, node, parents) => {
    if (parents.length > 40 || isAlias(node) || (isNode(node) && ('anchor' in node && node.anchor || node.tag))
      || (isPair(node) && (!isScalar(node.key) || typeof node.key.value !== 'string'))) fail(400, 'SKILL.md 元数据含不支持的结构');
  });
  const name = doc.get('name'), description = doc.get('description');
  if (typeof name !== 'string') fail(400, 'SKILL.md 缺少技能名称');
  if (typeof description !== 'string' || !description.trim() || Array.from(description.trim()).length > 256)
    fail(400, '技能描述不能为空或超过 256 个字符');
  return { name: skillName(name), description: description.trim() };
}

async function inspect(raw: Json | undefined, signal: AbortSignal): Promise<Loaded> {
  if (typeof raw !== 'string' || !raw || raw.length > Math.ceil(maxArchive / 3) * 4) fail(400, '请提供不超过 4 MiB 的 ZIP 文件');
  const bytes = Buffer.from(raw, 'base64');
  if (bytes.length > maxArchive || bytes.toString('base64') !== raw) fail(400, 'ZIP 文件编码或大小无效');
  let zip: ZipFile | undefined;
  try {
    zip = await fromBufferPromise(bytes, { strictFileNames: true, validateEntrySizes: true });
    if (zip.entryCount > 512) fail(400, 'ZIP 文件条目超过 512');
    const seen = new Map<string, { path: string; directory: boolean; explicit: boolean }>();
    const files = new Map<string, Buffer>();
    let total = 0;
    let manifest: string | undefined;
    for await (const entry of zip.eachEntry()) {
      signal.throwIfAborted();
      const directory = entry.fileName.endsWith('/');
      const path = filePath(directory ? entry.fileName.slice(0, -1) : entry.fileName);
      const mode = entry.externalFileAttributes >>> 16, kind = mode & 0o170000;
      if (entry.isEncrypted() || ![0, 8].includes(entry.compressionMethod) || (mode & 0o7000)
        || (kind && kind !== (directory ? 0o040000 : 0o100000)) || (!directory && (entry.externalFileAttributes & 0x10))
        || (directory && entry.uncompressedSize !== 0)) fail(400, 'ZIP 包含不支持的文件类型');
      const parts = path.split('/');
      for (let i = 0; i < parts.length; i++) {
        const prefix = parts.slice(0, i + 1).join('/');
        const key = prefix.normalize('NFC').toUpperCase();
        const explicit = i === parts.length - 1, isDir = !explicit || directory, previous = seen.get(key);
        if (previous && (previous.path !== prefix || previous.directory !== isDir || (explicit && previous.explicit)))
          fail(400, 'ZIP 包含冲突的文件路径');
        seen.set(key, { path: prefix, directory: isDir, explicit: explicit || !!previous?.explicit });
      }
      if (parts.at(-1)?.toLowerCase() === 'skill.md') {
        if (manifest || parts.at(-1) !== 'SKILL.md' || parts.length > 2 || directory) fail(400, 'ZIP 须在根目录或单一子目录中包含一个 SKILL.md');
        manifest = path;
      }
      // Enforce both declared and observed limits. No entry is ever extracted to disk.
      const limit = path === manifest ? maxManifest : maxFile;
      if (entry.compressedSize > bytes.length || entry.uncompressedSize > limit || total + entry.uncompressedSize > maxExpanded
        || entry.uncompressedSize > entry.compressedSize * 200) fail(400, 'ZIP 文件解压大小或压缩比超出限制');
      if (directory) continue;
      const stream = await zip.openReadStreamPromise(entry);
      const chunks: Buffer[] = [];
      let size = 0;
      for await (const chunk of stream) {
        signal.throwIfAborted();
        size += chunk.length;
        if (size > entry.uncompressedSize || size + total > maxExpanded) fail(400, 'ZIP 文件解压大小超出限制');
        chunks.push(chunk);
      }
      const data = Buffer.concat(chunks, size);
      if (size !== entry.uncompressedSize || crc32(data) !== entry.crc32) fail(400, 'ZIP 文件校验失败');
      files.set(path, data);
      total += size;
    }
    if (!manifest) fail(400, 'ZIP 中没有 SKILL.md');
    const prefix = manifest.slice(0, -'SKILL.md'.length);
    if (prefix && [...seen.values()].some(entry => entry.path !== prefix.slice(0, -1) && !entry.path.startsWith(prefix)))
      fail(400, 'ZIP 包含技能目录以外的文件');
    return { info: metadata(files.get(manifest)!), files: new Map([...files].map(([path, data]) => [path.slice(prefix.length), data])),
      digest: createHash('sha256').update(bytes).digest('hex') };
  } catch (error) {
    signal.throwIfAborted();
    if (error instanceof Error && 'status' in error) throw error;
    return fail(400, 'ZIP 或 SKILL.md 格式无效');
  } finally {
    zip?.close();
  }
}

function catalog(store: Store): Catalog {
  return store.get<Catalog>('assistant-skills', 'catalog') ?? { skills: [], revision: 0 };
}

// Builtins travel with the release. Only the user-installed catalog has a database revision.
function list(book: Catalog, guides: typeof workGuide[]) {
  return { ...book, builtinSkills: guides.map(({ name, description }) => ({ name, description })) };
}

function resource(store: Store, guides: typeof workGuide[], nameValue: Json | undefined, pathValue: Json | undefined) {
  const path = filePath(pathValue === undefined ? 'SKILL.md' : pathValue);
  const builtin = guides.find(guide => guide.name === nameValue);
  if (builtin) {
    const text = builtin.files.get(path);
    if (text === undefined) fail(404, '技能文件不存在');
    return { name: builtin.name, path, text };
  }
  const name = skillName(nameValue);
  const raw = store.get<string>('assistant-skills.files', name + '/' + path);
  if (raw === undefined) fail(404, '技能文件不存在');
  const bytes = Buffer.from(raw, 'base64');
  let text: string;
  try { text = decoder.decode(bytes); } catch { return fail(415, '该资源不是 UTF-8 文本'); }
  if (/(?![\r\n\t])[\p{Cc}]/u.test(text)) fail(415, '该资源不是 UTF-8 文本');
  return { name, path, text };
}

const fields = {
  list: [], preview: ['archive'], install: ['archive', 'digest', 'revision'], remove: ['name', 'revision'], read: ['name', 'path'],
} as const;
function keys(input: JsonObject, allowed: readonly string[]) {
  if (Object.keys(input).some(key => !allowed.includes(key))) fail(400, '技能请求包含未知字段');
}

export function createAssistantSkills(getMachines: () => MachineClient | undefined = () => undefined): Extension {
  return {
    id: 'assistant-skills', name: '助手技能', capabilities: ['assistant.skills'],
    permissions: ['service.provide:assistant-skills.manage', 'service.provide:assistant-skills.machine-catalog', 'contribute:tools', 'store.read', 'store.write'],
    activate(context) {
      activateInstalledSkills(context);
      registerMachineSkillCatalog(context, getMachines);
    },
  };
}

function activateInstalledSkills(context: ExtensionContext) {
  const { store } = context;
  const guides = () => context.contributions.list('tools').some(item => item.value.name === 'office_create')
    ? [workGuide, officeGuide] : [workGuide];
  const lifetime = new AbortController();
  let inspecting = false;
  context.provide('assistant-skills.manage', async (input, requestSignal) => {
    if (!input || typeof input !== 'object' || Array.isArray(input) || typeof input.action !== 'string' || !Object.hasOwn(fields, input.action))
      fail(400, '技能操作无效');
    const action = input.action as keyof typeof fields;
    keys(input, ['action', ...fields[action]]);
    if (action === 'list') return list(catalog(store), guides());
    if (action === 'read') return resource(store, guides(), input.name, input.path);
    const revision = input.revision;
    if (action !== 'preview' && (typeof revision !== 'number' || !Number.isSafeInteger(revision) || revision < 0 || revision >= Number.MAX_SAFE_INTEGER))
      fail(400, '技能目录版本无效');
    if (action === 'install' && (typeof input.digest !== 'string' || !/^[a-f0-9]{64}$/.test(input.digest))) fail(400, '请提供预览摘要');
    const signal = AbortSignal.any([requestSignal, lifetime.signal]);
    let loaded: Loaded | undefined;
    if (action !== 'remove') {
      if (inspecting) fail(409, '正在检查另一个技能包，请稍后重试');
      inspecting = true;
      try { loaded = await inspect(input.archive, signal); } finally { inspecting = false; }
      signal.throwIfAborted();
      if (action === 'preview') {
        const book = catalog(store), name = loaded.info.name;
        if (book.skills.some(skill => skill.name === name)) fail(409, '同名技能已安装');
        if (book.skills.length >= 32) fail(400, '最多可安装 32 个技能');
        return { ...loaded.info, files: [...loaded.files.keys()].sort(), digest: loaded.digest };
      }
      if (input.digest !== loaded.digest) fail(409, '技能包已变化，请重新预览');
    }
    if (action === 'remove' && guides().some(guide => guide.name === input.name)) fail(409, '内置技能无法移除');
    const name = loaded ? loaded.info.name : skillName(input.name);
    return store.transaction(() => {
      const book = catalog(store);
      if (revision !== book.revision) fail(409, '技能目录已更新，请重新加载');
      const index = book.skills.findIndex(skill => skill.name === name);
      if (loaded) {
        if (index >= 0) fail(409, '同名技能已安装');
        if (book.skills.length >= 32) fail(400, '最多可安装 32 个技能');
        for (const [path, data] of loaded.files) store.put('assistant-skills.files', name + '/' + path, data.toString('base64'));
        store.put('assistant-skills.paths', name, [...loaded.files.keys()]);
        book.skills.push(loaded.info);
        book.skills.sort((a, b) => a.name.localeCompare(b.name));
      } else {
        if (index < 0) fail(404, '技能不存在');
        for (const path of store.get<string[]>('assistant-skills.paths', name)!) store.remove('assistant-skills.files', name + '/' + path);
        store.remove('assistant-skills.paths', name);
        book.skills.splice(index, 1);
      }
      book.revision++;
      store.put('assistant-skills', 'catalog', book);
      return list(book, guides());
    });
  });
  context.contribute('tools', 'assistant_skill_read', {
    name: 'assistant_skill_read', description: '每次读取至多 6000 个字符。用 nextOffset 继续读取技能的 SKILL.md 或包内 UTF-8 文本。',
    parameters: { type: 'object', properties: { name: { type: 'string' }, path: { type: 'string' }, offset: { type: 'integer', minimum: 0 } }, required: ['name'], additionalProperties: false },
    async execute(args, signal) {
      signal.throwIfAborted();
      lifetime.signal.throwIfAborted();
      keys(args, ['name', 'path', 'offset']);
      const offset = args.offset === undefined ? 0 : args.offset;
      if (typeof offset !== 'number' || !Number.isSafeInteger(offset) || offset < 0) fail(400, '阅读偏移须为非负整数');
      const { name, path, text } = resource(store, guides(), args.name, args.path);
      const page: string[] = [];
      let position = 0;
      // Iterate Unicode code points without allocating an array for the entire resource.
      for (const character of text) {
        if (position >= offset) {
          if (page.length === 6000) return { name, path, text: page.join(''), nextOffset: position };
          page.push(character);
        }
        position++;
      }
      if (position < offset) fail(400, '阅读偏移超出文件末尾');
      return { name, path, text: page.join(''), nextOffset: null };
    },
  });
  context.defer(() => lifetime.abort(Object.assign(new Error('助手技能插件已停用'), { status: 503 })));
}
