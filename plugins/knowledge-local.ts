import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';
import { constants, closeSync, existsSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ExtensionContext, KnowledgeBackend, KnowledgeQuery } from '../packages/plugin-sdk/src/index.ts';
import type { KnowledgeEntry, KnowledgeLayer } from '../packages/protocol/src/index.ts';

const run = promisify(execFile);
const layers: KnowledgeLayer[] = ['personal', 'global', 'project'];
const collection = 'knowledge';

function safeId(id: string): string {
  if (typeof id !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/.test(id)) {
    throw new Error('Invalid knowledge id: use 1–128 letters, digits, underscores or hyphens');
  }
  return id;
}

function validateScope(layer: KnowledgeLayer | undefined, projectId: string | undefined): void {
  if (layer !== undefined && !layers.includes(layer)) throw new Error('Invalid knowledge layer');
  if (projectId !== undefined && (typeof projectId !== 'string' || !projectId.trim())) {
    throw new Error('projectId must be a non-empty string');
  }
}

function normalizedTags(tags: unknown): string[] {
  if (!Array.isArray(tags) || tags.length > 64 || tags.some(tag => typeof tag !== 'string' || !tag.trim() || tag.length > 100 || /[\r\n]/.test(tag)))
    throw Object.assign(new Error('最多可填写 64 个标签，每个标签须为 1 至 100 字的单行文本'), { status: 400 });
  return [...new Set(tags.map(tag => tag.trim()))];
}

function validateEntry(entry: KnowledgeEntry): void {
  if (entry.importance !== undefined && !['P0', 'P1', 'P2', 'P3'].includes(entry.importance))
    throw Object.assign(new Error('重要级必须是 P0、P1、P2 或 P3'), { status: 400 });
  safeId(entry.id);
  validateScope(entry.layer, entry.projectId);
  if (!layers.includes(entry.layer)) throw new Error('Knowledge layer is required');
  if (entry.layer === 'project' && !entry.projectId) throw new Error('Project knowledge requires projectId');
  if (typeof entry.title !== 'string' || !entry.title.trim()) throw new Error('Knowledge title is required');
  if (typeof entry.content !== 'string') throw new Error('Knowledge content must be a string');
  if (typeof entry.updatedAt !== 'string' || !Number.isFinite(Date.parse(entry.updatedAt))) {
    throw new Error('Invalid knowledge updatedAt');
  }
}

/** Only this backend owns knowledge files. Store entries are a rebuildable index. */
export function createLocalKnowledge(context: ExtensionContext): KnowledgeBackend {
  const directory = join(context.dataDir, 'knowledge');
  function ensureDirectory(): void {
    mkdirSync(context.dataDir, { recursive: true });
    if (!existsSync(directory)) mkdirSync(directory);
    const info = lstatSync(directory);
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('Knowledge directory must be a real directory');
  }
  function filePath(id: string): string { return join(directory, `${safeId(id)}.md`); }

  function readEntry(id: string): KnowledgeEntry {
    // O_NOFOLLOW prevents a manually added symlink from reading outside this backend.
    const fd = openSync(filePath(id), constants.O_RDONLY | constants.O_NOFOLLOW);
    let markdown: string;
    try { markdown = readFileSync(fd, 'utf8'); } finally { closeSync(fd); }
    return parseEntry(id, markdown);
  }
  function parseEntry(id: string, markdown: string): KnowledgeEntry {
    const match = /^---\n([^\n]+)\n---\n([\s\S]*)$/.exec(markdown);
    if (!match) throw new Error(`Invalid knowledge Markdown: ${id}`);
    const metadata: unknown = JSON.parse(match[1]!);
    if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) {
      throw new Error(`Invalid knowledge metadata: ${id}`);
    }
    const entry = { ...metadata, content: match[2]! } as KnowledgeEntry;
    validateEntry(entry);
    if (entry.tags !== undefined) entry.tags = normalizedTags(entry.tags);
    if (entry.id !== id) throw new Error(`Knowledge filename and metadata id differ: ${id}`);
    return entry;
  }

  return {
    async revision(id, commit) {
      const path = 'knowledge/' + safeId(id) + '.md';
      const repo = join(context.dataDir, '.git');
      if (commit !== undefined && !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(commit)) throw Object.assign(new Error('修订标识无效'), { status: 400 });
      async function git(...args: string[]) {
        return (await run('git', ['--git-dir=' + repo, ...args], { timeout: 15000, maxBuffer: 4 * 1024 * 1024 })).stdout;
      }
      try {
        if (!lstatSync(repo).isDirectory()) throw new Error();
        if (commit) await git('merge-base', '--is-ancestor', commit, 'HEAD');
        const log = (await git('log', '-2', '--no-renames', '--format=%H', '--name-status', commit ?? 'HEAD', '--', path)).trim();
        if (!log) return null;
        const [hash, change, previous, priorChange] = log.split(/\n+/);
        if (!hash || (commit && hash !== commit) || !/^[AM]\t/.test(change ?? '')) return null;
        const entry = parseEntry(id, await git('show', hash + ':' + path));
        // A predecessor in another scope cannot be opened by this reader.
        let visiblePrevious: string | undefined;
        if (change?.startsWith('M') && previous && /^[AM]\t/.test(priorChange ?? '')) {
          const prior = parseEntry(id, await git('show', previous + ':' + path));
          if (prior.layer === entry.layer && prior.projectId === entry.projectId) visiblePrevious = previous;
        }
        const current = readEntry(id);
        if (entry.layer !== current.layer || entry.projectId !== current.projectId) return null;
        return { entry, commit: hash, ...(visiblePrevious ? { previous: visiblePrevious } : {}) };
      } catch {
        throw Object.assign(new Error('无法读取该知识页的本地版本记录'), { status: 409 });
      }
    },
    async list(query: KnowledgeQuery = {}) {
      validateScope(query.layer, query.projectId);
      if (query.query !== undefined && typeof query.query !== 'string') throw new Error('query must be a string');
      ensureDirectory();
      const entries: KnowledgeEntry[] = [];
      for (const file of readdirSync(directory, { withFileTypes: true })) {
        if (!file.name.endsWith('.md')) continue;
        if (!file.isFile()) throw new Error(`Knowledge Markdown must be a regular file: ${file.name}`);
        entries.push(readEntry(file.name.slice(0, -3)));
      }
      // Reconcile only after every file parses, so corrupt Markdown cannot erase the index.
      context.store.transaction(() => {
        const ids = new Set(entries.map(entry => entry.id));
        for (const old of context.store.list<KnowledgeEntry>(collection)) {
          if (!ids.has(old.id)) context.store.remove(collection, old.id);
        }
        for (const entry of entries) context.store.put(collection, entry.id, entry);
      });
      const keywords = (query.query ?? '').trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
      return entries.filter(entry => {
        const text = `${entry.title}\n${entry.content}`.toLocaleLowerCase();
        return (!query.layer || entry.layer === query.layer)
          && (!query.projectId || entry.projectId === query.projectId)
          && (query.importance === undefined || entry.importance === query.importance)
          && (query.tag === undefined || entry.tags?.includes(query.tag))
          && keywords.every(keyword => text.includes(keyword));
      }).sort((a, b) => (a.importance ?? 'P4').localeCompare(b.importance ?? 'P4') || a.id.localeCompare(b.id));
    },
    async put(input, expectedUpdatedAt) {
      const entry: KnowledgeEntry = {
        id: input.id ?? randomUUID(), layer: input.layer, title: input.title,
        content: input.content, updatedAt: new Date().toISOString(),
        ...(input.projectId !== undefined ? { projectId: input.projectId } : {}),
      };
      ensureDirectory();
      // All writers in this service share the file backend. Keep the version check
      // and rename synchronous, after any asynchronous plugin hooks have finished.
      let prior: KnowledgeEntry | undefined;
      if (input.id) {
        try { prior = readEntry(entry.id); }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
      }
      if (expectedUpdatedAt !== undefined && prior?.updatedAt !== expectedUpdatedAt)
        throw Object.assign(new Error('知识页已有新版本或已删除，请先核对最新内容'), { status: 409 });
      if (prior && Date.parse(prior.updatedAt) >= Date.parse(entry.updatedAt))
        entry.updatedAt = new Date(Date.parse(prior.updatedAt) + 1).toISOString();
      const importance = input.importance === undefined ? prior?.importance : input.importance;
      if (importance != null) entry.importance = importance;
      validateEntry(entry);
      const tags = input.tags === undefined ? prior?.tags : normalizedTags(input.tags);
      if (tags?.length) entry.tags = tags;
      const { content, ...metadata } = entry;
      const temporary = join(directory, `.${randomUUID()}.tmp`);
      // Rename publishes a complete file. A failed index update is repaired by list().
      try {
        writeFileSync(temporary, `---\n${JSON.stringify(metadata)}\n---\n${content}`, { flag: 'wx', mode: 0o600 });
        renameSync(temporary, filePath(entry.id));
      } finally { rmSync(temporary, { force: true }); }
      context.store.put(collection, entry.id, entry);
      return entry;
    },
    async remove(id) {
      const path = filePath(id);
      ensureDirectory();
      let removed = false;
      try { rmSync(path); removed = true; }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
      context.store.remove(collection, id);
      return removed;
    },
  };
}
