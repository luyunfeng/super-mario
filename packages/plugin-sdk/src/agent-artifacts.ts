import { parse } from 'acorn';
import { createHash } from 'node:crypto';
import { isBuiltin } from 'node:module';

export interface AgentArtifactManifest { id: string; version: string; sha256: string; apiVersion: 1 }
export interface AgentArtifactApproval { id: string; version: string; sha256: string; approved: true }
export interface AgentArtifactInput { manifest: AgentArtifactManifest; source: string; approval: AgentArtifactApproval }

/** JSON boundaries reject accessors, exotic prototypes, functions and cyclic objects before reading fields. */
export function validateAgentArtifactJson(value: unknown, seen = new Set<object>()): void {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return;
  if (typeof value === 'number' && Number.isFinite(value)) return;
  if (typeof value !== 'object' || seen.has(value)) throw new Error('制品参数必须是纯 JSON');
  const prototype = Object.getPrototypeOf(value);
  if (Array.isArray(value) ? prototype !== Array.prototype : prototype !== Object.prototype && prototype !== null) throw new Error('制品参数不接受类实例');
  seen.add(value);
  for (const key of Reflect.ownKeys(value)) {
    if (Array.isArray(value) && key === 'length') continue;
    const descriptor = Object.getOwnPropertyDescriptor(value, key)!;
    if (typeof key !== 'string' || !('value' in descriptor) || !descriptor.enumerable) throw new Error('制品参数必须是纯 JSON 数据');
    validateAgentArtifactJson(descriptor.value, seen);
  }
  seen.delete(value);
}
function object(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}
export function validateAgentArtifactManifest(value: unknown): AgentArtifactManifest {
  validateAgentArtifactJson(value);
  if (!object(value) || typeof value.id !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(value.id)
    || typeof value.version !== 'string' || !/^[0-9]+\.[0-9]+\.[0-9]+(?:[-+][0-9A-Za-z.+-]+)?$/.test(value.version)
    || value.apiVersion !== 1 || typeof value.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(value.sha256)) {
    throw new Error('无效的制品 manifest（需 id、version、apiVersion:1、SHA256）');
  }
  return { id: value.id, version: value.version, apiVersion: 1, sha256: value.sha256 };
}
export function agentArtifactSha256(source: string): string {
  if (typeof source !== 'string' || !source.trim()) throw new Error('制品 source 必须为非空 ESM 字符串');
  return createHash('sha256').update(source, 'utf8').digest('hex');
}
export function verifyAgentArtifact(value: unknown): AgentArtifactInput {
  validateAgentArtifactJson(value);
  if (!object(value)) throw new Error('制品参数必须是对象');
  const manifest = validateAgentArtifactManifest(value.manifest);
  const approval = value.approval;
  if (!object(approval) || approval.approved !== true || approval.id !== manifest.id
    || approval.version !== manifest.version || approval.sha256 !== manifest.sha256) {
    throw new Error('未确认此插件的精确版本与 SHA256');
  }
  if (typeof value.source !== 'string' || agentArtifactSha256(value.source) !== manifest.sha256) throw new Error('制品 SHA256 不符');
  return { manifest, source: value.source, approval: { id: manifest.id, version: manifest.version, sha256: manifest.sha256, approved: true } };
}

/** Parse dependencies without executing code. Only host builtins and the public SDK
 * are trusted outside this single-file bundle; arbitrary imports need a separate review.
 */
function moduleSource(source: string): string {
  const pending: unknown[] = [parse(source, { ecmaVersion: 'latest', sourceType: 'module' })];
  const imports: Array<{ start: number; end: number; value: string }> = [];
  while (pending.length) {
    const current = pending.pop();
    if (!current || typeof current !== 'object') continue;
    if (Array.isArray(current)) { pending.push(...current); continue; }
    const node = current as Record<string, unknown>;
    if (node.type === 'ImportExpression' || (node.type === 'MetaProperty' && (node.meta as { name?: string }).name === 'import')) throw new Error('制品禁止动态 import 与 import.meta，请预先打包为单文件 ESM');
    if (['ImportDeclaration', 'ExportNamedDeclaration', 'ExportAllDeclaration'].includes(String(node.type)) && node.source) imports.push(node.source as { start: number; end: number; value: string });
    for (const child of Object.values(node)) if (child && typeof child === 'object') pending.push(child);
  }
  for (const item of imports.sort((a,b)=>b.start-a.start)) {
    let specifier = item.value;
    if (isBuiltin(specifier)) specifier = specifier.startsWith('node:') ? specifier : `node:${specifier}`;
    else if (specifier === 'super-mario/plugin-sdk' || specifier === '@super-mario/plugin-sdk') {
      specifier = new URL(import.meta.url.endsWith('.ts') ? './index.ts' : './index.js', import.meta.url).href;
    } else throw new Error('制品仅允许 Node 内置模块与公开 SDK import，禁止相对或外部依赖');
    source = source.slice(0, item.start) + JSON.stringify(specifier) + source.slice(item.end);
  }
  return source;
}

/** Verification and dependency checks MUST complete before any artifact code can execute.
 * The module namespace contains functions; callers must never send it across a JSON API.
 */
export async function loadVerifiedAgentArtifact(value: unknown): Promise<{ default?: unknown }> {
  const verified = verifyAgentArtifact(value);
  const source = moduleSource(verified.source);
  return import(`data:text/javascript;base64,${Buffer.from(source, 'utf8').toString('base64')}`);
}
