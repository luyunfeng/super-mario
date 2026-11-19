import { randomUUID } from 'node:crypto';
import { constants, closeSync, fstatSync, existsSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { ExtensionContext, KnowledgeBackend, KnowledgeQuery } from '../packages/plugin-sdk/src/index.ts';
import type { KnowledgeEntry, KnowledgeLayer } from '../packages/protocol/src/index.ts';

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

function validateEntry(entry: KnowledgeEntry): void {
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
function localFiles(context: Pick<ExtensionContext, 'store' | 'dataDir'>): KnowledgeBackend & { purgeProjectPages(projectId: string, deferStoreCleanup: boolean): KnowledgeEntry[] } {
  const directory = join(context.dataDir, 'knowledge');
  function ensureDirectory(): void {
    for (const path of [dirname(context.dataDir), context.dataDir]) {
      mkdirSync(path, { recursive: true });
      if (!lstatSync(path).isDirectory()) throw new Error('Knowledge storage requires a real directory');
    }
    if (!existsSync(directory)) mkdirSync(directory);
    const info = lstatSync(directory);
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('Knowledge directory must be a real directory');
  }
  function filePath(id: string): string { return join(directory, `${safeId(id)}.md`); }

  function readEntry(id: string): KnowledgeEntry {
    // O_NOFOLLOW prevents a manually added symlink from reading outside this backend.
    const fd = openSync(filePath(id), constants.O_RDONLY | constants.O_NOFOLLOW);
    let markdown: string;
    try {
      const info = fstatSync(fd);
      if (!info.isFile() || info.nlink !== 1) throw new Error('Knowledge Markdown must be a private regular file');
      markdown = readFileSync(fd, 'utf8');
    } finally { closeSync(fd); }
    const match = /^---\n([^\n]+)\n---\n([\s\S]*)$/.exec(markdown);
    if (!match) throw new Error(`Invalid knowledge Markdown: ${id}`);
    const metadata: unknown = JSON.parse(match[1]!);
    if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) {
      throw new Error(`Invalid knowledge metadata: ${id}`);
    }
    const entry = { ...metadata, content: match[2]! } as KnowledgeEntry;
    validateEntry(entry);
    if (entry.id !== id) throw new Error(`Knowledge filename and metadata id differ: ${id}`);
    return entry;
  }

  function readAll() {
    ensureDirectory();
    const entries: KnowledgeEntry[] = [];
    for (const file of readdirSync(directory, { withFileTypes: true })) {
      if (!file.name.endsWith('.md')) continue;
      if (!file.isFile()) throw new Error(`Knowledge Markdown must be a regular file: ${file.name}`);
      entries.push(readEntry(file.name.slice(0, -3)));
    }
    return entries;
  }

  return {
    purgeProjectPages(projectId, deferStoreCleanup) {
      const entries = readAll(), retained: KnowledgeEntry[] = [];
      for (const entry of entries) {
        if (entry.layer === 'project' && entry.projectId === projectId) {
          rmSync(filePath(entry.id));
          if (!deferStoreCleanup) context.store.remove(collection, entry.id);
        } else retained.push(entry);
      }
      if (!deferStoreCleanup) for (const cached of context.store.list<KnowledgeEntry>(collection)) {
        if (cached.layer === 'project' && cached.projectId === projectId) context.store.remove(collection, cached.id);
      }
      return retained.sort((a, b) => a.id.localeCompare(b.id));
    },
    async list(query: KnowledgeQuery = {}) {
      validateScope(query.layer, query.projectId);
      if (query.query !== undefined && typeof query.query !== 'string') throw new Error('query must be a string');
      const entries = readAll();
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
          && keywords.every(keyword => text.includes(keyword));
      }).sort((a, b) => a.id.localeCompare(b.id));
    },
    async put(input) {
      const entry: KnowledgeEntry = {
        id: input.id ?? randomUUID(), layer: input.layer, title: input.title,
        content: input.content, updatedAt: new Date().toISOString(),
        ...(input.projectId !== undefined ? { projectId: input.projectId } : {}),
      };
      validateEntry(entry);
      ensureDirectory();
      const { content, ...metadata } = entry;
      const temporary = join(directory, `.${randomUUID()}.tmp`);
      // Check the host's project write barrier before publishing any file. If the
      // filesystem write fails the index rolls back; list() can repair a failed commit.
      context.store.transaction(() => {
        context.store.put(collection, entry.id, entry);
        try {
          writeFileSync(temporary, `---\n${JSON.stringify(metadata)}\n---\n${content}`, { flag: 'wx', mode: 0o600 });
          renameSync(temporary, filePath(entry.id));
        } finally { rmSync(temporary, { force: true }); }
      });
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

export function createLocalKnowledge(context: Pick<ExtensionContext, 'store' | 'dataDir'>): KnowledgeBackend {
  const { list, put, remove } = localFiles(context);
  return { list, put, remove };
}

/** Maintenance works even when the plugin's runtime contributions are disabled. */
export function purgeLocalProjectPages(context: Pick<ExtensionContext, 'store' | 'dataDir'>, projectId: string, deferStoreCleanup = false) {
  return localFiles(context).purgeProjectPages(projectId, deferStoreCleanup);
}
