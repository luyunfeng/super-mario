import { posix } from 'node:path';
import type { MachineClient } from '../../plugin-sdk/src/index.ts';
import type { ProjectDiscovery, ProjectWorkspaceBinding } from '../../protocol/src/index.ts';

/** Directory inspection always happens on the chosen computer, never on the server. */
class ProjectFolderError extends Error {
  readonly status: number;
  constructor(message: string, status = 400) { super(message); this.status = status; }
}

export function createProjectFolders(source: MachineClient | (() => MachineClient | undefined)) {
  const current = () => typeof source === 'function' ? source() : source;
  const machines: MachineClient = {
    list: () => current()?.list() ?? [],
    call(...args) { const client = current(); if (!client) throw new ProjectFolderError('电脑连接尚未就绪', 503); return client.call(...args); },
  };
  function available(machineId: unknown, method: string) {
    if (typeof machineId !== 'string' || !machineId.trim()) throw new ProjectFolderError('请选择电脑');
    const machine = machines.list().find(item => item.id === machineId);
    if (!machine) throw new ProjectFolderError('电脑不存在', 404);
    if (!machine.online) throw new ProjectFolderError('这台电脑已离线，请等待重新连接', 503);
    if (!machine.capabilities.includes(method)) throw new ProjectFolderError('这台电脑尚未提供项目文件夹发现能力，请升级电脑上的代理', 409);
    return machine;
  }
  async function validate(input: unknown): Promise<ProjectWorkspaceBinding> {
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw new ProjectFolderError('项目文件夹必须包含电脑和目录');
    const value = input as Record<string, unknown>;
    if (Object.keys(value).some(key => !['machineId', 'cwd'].includes(key)) || typeof value.cwd !== 'string' || !value.cwd.startsWith('/') || /[\0\r\n]/.test(value.cwd)) throw new ProjectFolderError('请选择电脑上的现有绝对目录');
    const machine = available(value.machineId, 'workspace.directory');
    let result;
    try { result = await machines.call(machine.id, 'workspace.directory', { cwd: value.cwd }, { timeoutMs: 15000 }); }
    catch { throw new ProjectFolderError('未能确认这个文件夹，请检查目录是否存在、是否可访问以及电脑连接状态。尚未保存项目。', 400); }
    if (!result || typeof result !== 'object' || Array.isArray(result) || result.exists !== true || typeof result.cwd !== 'string' || !result.cwd.startsWith('/') || /[\0\r\n]/.test(result.cwd)) throw new ProjectFolderError('电脑未能确认这个文件夹，请重新选择', 502);
    return { machineId: machine.id, cwd: result.cwd };
  }
  async function createDirectory(machineId: string, input: Record<string, unknown>) {
    const { parent, name } = input;
    if (Object.keys(input).some(key => key !== 'parent' && key !== 'name') ||
      (parent !== undefined && (typeof parent !== 'string' || !parent.trim() || parent.length > 4096 || parent.split('/').includes('..') || /\p{Cc}/u.test(parent))) ||
      typeof name !== 'string' || !name.trim() || name === '.' || name === '..' || /[/\\\p{Cc}]/u.test(name)) throw new ProjectFolderError('请提供单个文件夹名和有效父目录');
    const machine = available(machineId, 'workspace.directory.create');
    let result;
    try { result = await machines.call(machine.id, 'workspace.directory.create', { ...(parent === undefined ? {} : { parent }), name }, { timeoutMs: 15000 }); }
    catch (error) {
      if (error instanceof Error && error.message === '同名文件或文件夹已存在') throw new ProjectFolderError(error.message, 409);
      if (error instanceof Error && ['父目录不存在或不可访问', '相对父目录必须位于执行机主目录内', '父目录不可用或无权创建文件夹'].includes(error.message)) throw new ProjectFolderError(error.message);
      if (error && typeof error === 'object' && 'delivery' in error && error.delivery === 'no') throw error;
      throw new ProjectFolderError('新建目录结果未知，请检查电脑上的目录后再操作', 502);
    }
    if (!result || typeof result !== 'object' || Array.isArray(result) || result.exists !== true || typeof result.cwd !== 'string' ||
      !posix.isAbsolute(result.cwd) || /\p{Cc}/u.test(result.cwd) || posix.normalize(result.cwd) !== result.cwd || result.cwd.endsWith('/') || posix.basename(result.cwd) !== name) throw new ProjectFolderError('新建目录结果未知，电脑未确认预期路径', 502);
    return { cwd: result.cwd, exists: true };
  }
  async function discover(machineId: string, roots: string[] = []): Promise<ProjectDiscovery> {
    const machine = available(machineId, 'workspace.projects');
    if (roots.length > 12 || roots.some(root => !root.startsWith('/') || /[\0\r\n]/.test(root))) throw new ProjectFolderError('扫描根目录必须是绝对目录，最多添加 12 个');
    const result = await machines.call(machine.id, 'workspace.projects', roots.length ? { roots } : {}, { timeoutMs: 30000 });
    if (!result || typeof result !== 'object' || Array.isArray(result) || !Array.isArray(result.projects)
      || !Array.isArray(result.roots) || !Array.isArray(result.warnings) || typeof result.truncated !== 'boolean'
      || result.projects.some(item => !item || typeof item !== 'object' || Array.isArray(item) || typeof item.name !== 'string' || typeof item.cwd !== 'string' || !item.cwd.startsWith('/') || typeof item.exists !== 'boolean' || !Array.isArray(item.sources) || item.sources.some(source => typeof source !== 'string'))
      || [...result.roots, ...result.warnings].some(value => typeof value !== 'string')) throw new ProjectFolderError('电脑返回的项目目录列表格式无效', 502);
    return result as unknown as ProjectDiscovery;
  }
  async function prepare(input: Record<string, unknown>) {
    return input.workspace === undefined ? input : { ...input, workspace: await validate(input.workspace) };
  }
  return { discover, validate, prepare, createDirectory };
}
