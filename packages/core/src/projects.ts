import { randomUUID } from 'node:crypto';
import { isAbsolute, resolve } from 'node:path';
import type { EventBus, Store } from '../../plugin-sdk/src/index.ts';

import type { Project } from '../../protocol/src/index.ts';
export type { Project } from '../../protocol/src/index.ts';

export type ProjectFollowUp = NonNullable<Project['followUp']>;
type ProjectInput = { name: string; description?: string; memoryEnabled?: boolean; followUp?: ProjectFollowUp; workspace?: Project['workspace'] };
function fail(message: string, status: 400 | 404 | 409): never {
  throw Object.assign(new Error(message), { status });
}
function validate(input: unknown, partial: boolean): asserts input is Partial<ProjectInput> {
  if (!input || typeof input !== 'object' || Array.isArray(input)
    || ![Object.prototype, null].includes(Object.getPrototypeOf(input))) fail('项目参数必须为对象', 400);
  const value = input as Record<string, unknown>;
  if (Reflect.ownKeys(value).some(key => key !== 'name' && key !== 'description' && key !== 'followUp' && key !== 'workspace' && (partial || key !== 'memoryEnabled'))) fail('包含未知项目字段', 400);
  if ('workspace' in value) {
    const workspace = value.workspace as Record<string, unknown> | null;
    if (!workspace || typeof workspace !== 'object' || Array.isArray(workspace)
      || ![Object.prototype, null].includes(Object.getPrototypeOf(workspace))
      || Reflect.ownKeys(workspace).some(key => key !== 'machineId' && key !== 'cwd')
      || typeof workspace.machineId !== 'string' || !workspace.machineId.trim()
      || typeof workspace.cwd !== 'string' || workspace.cwd.includes('\0') || !isAbsolute(workspace.cwd)) fail('工作区必须包含电脑标识 machineId 和绝对文件夹路径 cwd', 400);
  }
  if ((!partial || 'name' in value) && (typeof value.name !== 'string' || !value.name.trim())) fail('项目名称不能为空', 400);
  if('memoryEnabled'in value&&typeof value.memoryEnabled!=='boolean')fail('自动提炼设置必须为布尔值',400);
  if ('followUp' in value) {
    const followUp = value.followUp as Record<string, unknown> | null;
    if (!followUp || typeof followUp !== 'object' || Array.isArray(followUp)
      || ![Object.prototype, null].includes(Object.getPrototypeOf(followUp))
      || Reflect.ownKeys(followUp).some(key => !['briefingEnabled', 'briefingTime', 'overdueReminders', 'automation'].includes(String(key)))
      || (followUp.briefingEnabled !== undefined && typeof followUp.briefingEnabled !== 'boolean')
      || typeof followUp.briefingTime !== 'string' || !/^([01]\d|2[0-3]):[0-5]\d$/.test(followUp.briefingTime)
      || typeof followUp.overdueReminders !== 'boolean'
      || !['inherit', 'conservative', 'balanced', 'quiet'].includes(followUp.automation as string)) fail('项目跟进设置无效', 400);
  }
  if ('description' in value && typeof value.description !== 'string') fail('项目描述必须为文本', 400);
}

/** Archival changes only the project record; knowledge remains independently stored. */
export function createProjects({ store, events }: { store: Store; events: EventBus }) {
  // HTTP validates the real directory on its owning machine. Storage only normalizes
  // the binding lexically; it must never inspect the server's local filesystem.
  const normalizeWorkspace = (workspace: NonNullable<Project['workspace']>) => ({ machineId: workspace.machineId.trim(), cwd: resolve(workspace.cwd) });
  function boundProject(workspace: NonNullable<Project['workspace']>, exceptId?: string) {
    return store.list<Project>('projects').find(project => project.id !== exceptId && project.workspace
      && project.workspace.machineId === workspace.machineId && resolve(project.workspace.cwd) === workspace.cwd);
  }
  function read(id: string): Project {
    if (typeof id !== 'string' || !id.trim()) fail('项目 ID 不能为空', 400);
    const project = store.get<Project>('projects', id);
    if (!project) fail('项目不存在', 404);
    return project;
  }
  function save(project: Project): Project {
    store.put('projects', project.id, project);
    events.publish('projects.changed', { id: project.id });
    return structuredClone(project);
  }
  return {
    list(): Project[] { return structuredClone(store.list<Project>('projects')); },
    create(input: ProjectInput): Project {
      validate(input, false);
      const workspace = input.workspace && normalizeWorkspace(input.workspace);
      const existing = workspace && boundProject(workspace);
      // Archived folders remain archived; importing again must not replace history.
      if (existing) return structuredClone(existing);
      const now = new Date().toISOString();
      return save({ id: randomUUID(), name: input.name.trim(), description: input.description?.trim() ?? '', ...(workspace ? { workspace } : {}), ...(input.memoryEnabled===undefined?{}:{memoryEnabled:input.memoryEnabled}), ...(input.followUp === undefined ? {} : { followUp: structuredClone(input.followUp) }), createdAt: now, updatedAt: now });
    },
    update(id: string, input: Partial<ProjectInput>): Project {
      validate(input, true);
      const project = read(id);
      const workspace = input.workspace && normalizeWorkspace(input.workspace);
      if (workspace && boundProject(workspace, id)) fail('该电脑的文件夹已绑定其他项目', 409);
      return save({ ...project, ...(input.name === undefined ? {} : { name: input.name.trim() }),
        ...(workspace ? { workspace } : {}),
        ...(input.description === undefined ? {} : { description: input.description.trim() }),
        ...(input.followUp === undefined ? {} : { followUp: structuredClone(input.followUp) }), updatedAt: new Date().toISOString() });
    },
    archive(id: string): Project {
      const project = read(id);
      if (project.archivedAt) return structuredClone(project);
      const now = new Date().toISOString();
      return save({ ...project, archivedAt: now, updatedAt: now });
    },
  };
}
