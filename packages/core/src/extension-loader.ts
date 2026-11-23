import { assertJson, assertPluginPermissions } from '../../plugin-sdk/src/index.ts';
import { createHash } from 'node:crypto';
import { lstat, readdir, readFile } from 'node:fs/promises';
import type { Dirent } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { Extension } from '../../plugin-sdk/src/index.ts';
import type { JsonObject } from '../../protocol/src/index.ts';

export type LocalPluginOrigin = {
  source: 'local'; version: string | null;
  failure?: 'manifest' | 'entry' | 'cycle';
  declaredDependencies?: string[];
};
type Loaded = { extension: Extension; config: JsonObject; origin: LocalPluginOrigin };
const validId = (value: unknown): value is string => typeof value === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(value);
const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
const stringList = (value: unknown): value is string[] => Array.isArray(value) && value.every(item => typeof item === 'string');
const versionPattern = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;

function readNavigation(value: unknown): Extension['navigation'] {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) throw new Error('Invalid plugin navigation');
  const ids = new Set<string>();
  return value.map(item => {
    if (!object(item) || !validId(item.id) || ids.has(item.id) ||
        typeof item.label !== 'string' || !item.label.trim() ||
        typeof item.route !== 'string' || !/^#[a-z]+(?:\/[\w-][\w.-]*)*(?:\?[\w=&-]+)?$/.test(item.route) ||
        new URLSearchParams(item.route.split('?')[1]).has('token')) throw new Error('Invalid plugin navigation entry');
    ids.add(item.id);
    return { id: item.id, label: item.label.trim(), route: item.route };
  });
}

function failed(id: string, reason: unknown): Extension {
  const message = reason instanceof Error ? reason.message : String(reason);
  return { id, name: id, capabilities: [], activate() { throw new Error(message); } };
}

/** Entry checks prevent accidental escapes, not hostile code: imported JS runs with full process privileges. */
async function regularPath(root: string, relative: string): Promise<string> {
  const parts = relative.split(/[\\/]/);
  if (isAbsolute(relative) || /^[A-Za-z]:/.test(relative) || parts.some(part => !part || part === '.' || part === '..')) {
    throw new Error('Invalid extension entry path');
  }
  let path = root;
  for (const [index, part] of parts.entries()) {
    path = join(path, part);
    const stat = await lstat(path);
    if (stat.isSymbolicLink() || (index === parts.length - 1 ? !stat.isFile() : !stat.isDirectory())) {
      throw new Error('Extension paths must be regular files and directories, without symlinks');
    }
  }
  return path;
}

export async function loadExtensions(dataDir: string, options: { reservedIds?: string[] } = {}): Promise<Loaded[]> {
  const root = join(dataDir, 'extensions');
  let children: Dirent[];
  try {
    const stat = await lstat(root);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Extensions root must be a real directory');
    children = await readdir(root, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    return [{ extension: failed(uniqueErrorId('extensions', new Set(options.reservedIds)), error), config: {}, origin: { source: 'local', version: null, failure: 'manifest' } }];
  }
  const directories = children
    .filter(entry => entry.isDirectory() || entry.isSymbolicLink()).sort((a, b) => a.name.localeCompare(b.name, 'en'));
  // Reserve every manifest ID before allocating diagnostic IDs, including IDs of later entries.
  const manifests = await Promise.all(directories.map(async directory => {
    try {
      const folder = join(root, directory.name);
      if (directory.isSymbolicLink()) throw new Error('Extension directory must not be a symlink');
      const path = await regularPath(folder, 'super-mario.extension.json');
      return { directory: directory.name, manifest: JSON.parse(await readFile(path, 'utf8')) as unknown };
    } catch (error) { return { directory: directory.name, manifest: undefined, error }; }
  }));
  const used = new Set(options.reservedIds);
  const unavailable = new Set(used);
  for (const { manifest } of manifests) if (object(manifest) && validId(manifest.id)) unavailable.add(manifest.id);
  const loaded: Loaded[] = [];
  for (const item of manifests) {
    let id = uniqueErrorId(item.directory, unavailable);
    let config: JsonObject = {};
    const manifest = item.manifest;
    const version = object(manifest) && typeof manifest.version === 'string' && versionPattern.test(manifest.version) ? manifest.version : null;
    const origin: LocalPluginOrigin = { source: 'local', version };
    let failure: LocalPluginOrigin['failure'] = 'manifest';
    let name: string | undefined;
    let permissions: string[] | undefined;
    try {
      if (item.error) throw item.error;
      if (!object(manifest) || !validId(manifest.id)) throw new Error('Invalid extension id');
      if (used.has(manifest.id)) throw new Error(`Duplicate or reserved extension id: ${manifest.id}`);
      id = manifest.id;
      used.add(id);
      if (version === null) throw new Error('Invalid extension version (expected semver)');
      if (manifest.apiVersion !== 1) throw new Error('Unsupported extension apiVersion');
      if (manifest.name !== undefined && (typeof manifest.name !== 'string' || !manifest.name.trim())) throw new Error('Invalid extension name');
      if (manifest.dependencies !== undefined && (!stringList(manifest.dependencies) || !manifest.dependencies.every(validId))) throw new Error('Invalid extension dependencies');
      name = manifest.name as string | undefined;
      origin.declaredDependencies = manifest.dependencies as string[] | undefined;
      if (manifest.extensionPoints !== undefined && (!Array.isArray(manifest.extensionPoints) || !manifest.extensionPoints.every(point => object(point) && validId(point.id) && point.id.startsWith(id + '.') && point.version === 1 && (point.transport === undefined || point.transport === 'json')))) throw new Error('Invalid manifest extensionPoints');
      if (manifest.permissions !== undefined) assertPluginPermissions(manifest.permissions);
      permissions = manifest.permissions as string[] | undefined;
      if (manifest.runtime !== undefined && manifest.runtime !== 'local') throw new Error('Only trusted local runtime is implemented');
      if (manifest.config !== undefined && !object(manifest.config)) throw new Error('Invalid extension config');
      assertJson(manifest.config ?? {});
      config = (manifest.config ?? {}) as JsonObject;
      if (typeof manifest.main !== 'string') throw new Error('Invalid extension main');
      failure = 'entry';
      const path = await regularPath(join(root, item.directory), manifest.main);
      // No cache busting or hot reload: one module instance per installed entry URL.
      const module = await import(pathToFileURL(path).href);
      const extension: unknown = typeof module.default === 'function' ? await module.default() : module.default;
      if (!object(extension) || extension.id !== id || typeof extension.name !== 'string' || !stringList(extension.capabilities)
        || typeof extension.activate !== 'function'
        || (extension.dependencies !== undefined && (!stringList(extension.dependencies) || !extension.dependencies.every(validId)))) {
        throw new Error('Invalid Extension default export (id must match manifest)');
      }
      const sdk = extension as unknown as Extension;
      if (sdk.permissions !== undefined) assertPluginPermissions(sdk.permissions);
      loaded.push({ extension: { ...sdk, navigation: readNavigation(manifest.navigation ?? sdk.navigation), extensionPoints: manifest.extensionPoints as Extension['extensionPoints'] ?? sdk.extensionPoints, permissions: manifest.permissions as string[] | undefined ?? sdk.permissions, name: manifest.name as string | undefined ?? sdk.name,
        dependencies: [...new Set([...(sdk.dependencies ?? []), ...(manifest.dependencies as string[] | undefined ?? [])])],
        activate: context => sdk.activate(context) }, config, origin });
    } catch (error) {
      loaded.push({ extension: { ...failed(id, error), name: name ?? id, permissions }, config, origin: { ...origin, failure } });
    }
  }
  // PluginHost rejects dependency cycles during registration. Turn cycle members into
  // dependency-free failures first so callers can register the whole batch safely.
  const entries = new Map(loaded.map(item => [item.extension.id, item]));
  const visiting: string[] = [];
  const visited = new Set<string>();
  const cyclic = new Set<string>();
  const visit = (id: string): void => {
    const index = visiting.indexOf(id);
    if (index !== -1) { for (const member of visiting.slice(index)) cyclic.add(member); return; }
    if (visited.has(id)) return;
    visiting.push(id);
    for (const dependency of entries.get(id)?.extension.dependencies ?? []) visit(dependency);
    visiting.pop(); visited.add(id);
  };
  for (const id of entries.keys()) visit(id);
  for (const id of cyclic) {
    const item = entries.get(id)!;
    item.origin = { ...item.origin, failure: 'cycle', declaredDependencies: item.extension.dependencies };
    const { name, capabilities, permissions } = item.extension;
    item.extension = { ...failed(id, 'Extension dependency cycle'), name, capabilities, permissions };
  }
  return loaded;
}

function uniqueErrorId(directory: string, used: Set<string>): string {
  const safe = directory.replace(/[^a-zA-Z0-9._-]/g, '_');
  const suffix = safe === directory ? '' : `.${createHash('sha256').update(directory).digest('hex').slice(0, 12)}`;
  const base = `error.${safe}${suffix}`;
  let id = base;
  for (let n = 2; used.has(id); n++) id = `${base}.${n}`;
  used.add(id);
  return id;
}
