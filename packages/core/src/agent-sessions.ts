import { isAbsolute, relative, resolve } from 'node:path';
import type { MachineClient, Store } from '../../plugin-sdk/src/index.ts';
import type { Approval, ExecutorInfo, JsonObject, Message, Project, Run, Todo } from '../../protocol/src/index.ts';
import type { AgentSessionDiscovery, NativeResumeSpec, ObservedAgentSession } from '../../protocol/src/agent-sessions.ts';

type ApprovalInput = Pick<Approval, 'kind' | 'title' | 'details' | 'params' | 'todoId'>;
export class AgentSessionError extends Error { status: number; constructor(message: string, status = 400) { super(message); this.status = status; } }
const fail = (message: string, status = 400): never => { throw new AgentSessionError(message, status); };
const text = (value: unknown, label: string): string => typeof value === 'string' && value.trim() && !/[\0\r\n]/.test(value) ? value.trim() : fail(`${label}不能为空或包含控制字符`);
const within = (root: string, path: string) => { const rest = relative(resolve(root), resolve(path)); return rest === '' || (!isAbsolute(rest) && rest !== '..' && !rest.startsWith('../')); };
export function nativeResumeSpec(value: unknown): NativeResumeSpec {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return fail('原生恢复参数无效');
  const input = value as Record<string, unknown>;
  if (Object.keys(input).some(key => !['executorId', 'nativeSessionId'].includes(key)) || typeof input.executorId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(input.executorId)) return fail('原生恢复执行者标识无效');
  const nativeSessionId = text(input.nativeSessionId, '原生会话标识');
  if (nativeSessionId.length > 256 || /[\s\p{Cc}]/u.test(nativeSessionId) || nativeSessionId.startsWith('-')) return fail('原生会话标识无效');
  return { executorId: input.executorId as NativeResumeSpec['executorId'], nativeSessionId };
}

/** Parsers declare their own native evidence sources; core never knows vendor event formats. */
export function nativeResultSources(executor: ExecutorInfo | undefined): string[] {
  const sources = executor?.nativeResultSources;
  return Array.isArray(sources) && sources.length > 0 && sources.length <= 8
    && sources.every(value => typeof value === 'string' && /^[A-Za-z0-9._:-]{1,80}$/.test(value) && !['screen', 'runner', 'demo'].includes(value)) ? [...new Set(sources)] : [];
}

/** The server asks the owning node for metadata. It never treats its own filesystem as remote. */
export function createAgentSessions(options: {
  store: Store; machines: () => MachineClient | undefined; executors: () => ExecutorInfo[];
  propose: (input: ApprovalInput) => Approval; pinExecutor?: (source: Message | undefined, id: string) => unknown;
}) {
  function machine(id: string, ...methods: string[]) {
    const m = options.machines()?.list().find(m => m.id === id);
    if (!m) return fail('电脑不存在', 404);
    if (!m.online) return fail('电脑离线，无法读取或恢复会话', 503);
    if (methods.some(method => !m.capabilities.includes(method))) return fail('电脑代理不支持原生会话发现或恢复，请升级代理', 409);
    return m;
  }
  function project(id: unknown) {
    if (id === undefined || id === '') return undefined;
    const p = options.store.get<Project>('projects', text(id, '项目'));
    if (!p || p.archivedAt) return fail('项目不存在或已归档', 409);
    return p;
  }
  function session(value: unknown): ObservedAgentSession {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return fail('电脑返回的会话元数据格式无效', 502);
    const s = value as ObservedAgentSession;
    const spec = nativeResumeSpec({ executorId: s.executorId, nativeSessionId: s.nativeSessionId });
    if (typeof s.id !== 'string' || s.id !== `${spec.executorId}:${spec.nativeSessionId}` || typeof s.cwd !== 'string' || !isAbsolute(s.cwd)
      || /[\0\r\n]/.test(s.cwd) || typeof s.observedAt !== 'string' || !Number.isFinite(Date.parse(s.observedAt))
      || s.source !== 'session-metadata' || s.state !== 'historical' || s.writable !== false
      || (s.archived !== undefined && s.archived !== true)
      || (s.fileModifiedAt !== undefined && (typeof s.fileModifiedAt !== 'string' || !Number.isFinite(Date.parse(s.fileModifiedAt))))
      || (s.metadataTimestamp !== undefined && (typeof s.metadataTimestamp !== 'string' || !Number.isFinite(Date.parse(s.metadataTimestamp))))) return fail('电脑返回的会话元数据格式无效', 502);
    return { id: s.id, ...spec, cwd: s.cwd, observedAt: s.observedAt, source: 'session-metadata', state: 'historical', writable: false,
      ...(s.archived ? { archived: true } : {}), ...(s.metadataTimestamp ? { metadataTimestamp: s.metadataTimestamp } : {}), ...(s.fileModifiedAt ? { fileModifiedAt: s.fileModifiedAt } : {}), ...(typeof s.parentNativeSessionId === 'string' ? { parentNativeSessionId: s.parentNativeSessionId } : {}) };
  }
  function allowedProject(p: Project | undefined, machineId: string, cwd?: string) {
    if (p?.workspace && (p.workspace.machineId !== machineId || (cwd !== undefined && !within(p.workspace.cwd, cwd)))) return fail('会话不属于项目绑定的电脑或目录', 409);
  }
  async function lookup(machineId: string, spec: NativeResumeSpec, cwd: string) {
    const m = machine(machineId, 'agents.session', 'executor.resume');
    if (!isAbsolute(cwd) || /[\0\r\n]/.test(cwd)) return fail('恢复目录必须是绝对目录');
    let raw;
    try { raw = await options.machines()!.call(m.id, 'agents.session', { ...spec, cwd }, { timeoutMs: 30000 }); }
    catch { return fail('无法确认原生线程及目录；不会创建新会话作为回退', 409); }
    const found = session(raw);
    if (found.executorId !== spec.executorId || found.nativeSessionId !== spec.nativeSessionId) return fail('电脑返回了不同的原生线程', 502);
    return found;
  }
  async function discover(input: { machineId?: string; projectId?: string; todoId?: string } = {}) {
    const task = input.todoId ? options.store.get<Todo>('todos', text(input.todoId, '事项')) : undefined;
    if (input.todoId && !task) return fail('事项不存在', 404);
    if (task && input.projectId !== undefined && input.projectId !== task.projectId) return fail('事项不属于所选项目', 403);
    const p = project(input.projectId ?? task?.projectId);
    const taskRuns = task ? options.store.list<Run>('runs').filter(r => r.todoId === task.id) : [];
    const taskOwns = (machineId: string, item: ObservedAgentSession) => taskRuns.some(run => run.machineId === machineId && run.executorId === `${machineId}/${item.executorId}`
      && (run.nativeSessionId === item.nativeSessionId || run.nativeResume?.nativeSessionId === item.nativeSessionId));
    if (p && !p.workspace) return { capturedAt: new Date().toISOString(), machines: [], reason: '项目尚未绑定电脑与目录，请先绑定后读取该项目的会话' };
    if (p?.workspace && input.machineId && input.machineId !== p.workspace.machineId) return fail('所选电脑不属于项目', 409);
    const machineId = input.machineId || p?.workspace?.machineId;
    const available = options.machines()?.list() ?? [];
    if (machineId && !available.some(m => m.id === machineId)) return fail('电脑不存在', 404);
    const targets = available.filter(m => (!machineId || m.id === machineId) && (!task || taskRuns.some(r => r.machineId === m.id)));
    const executors = options.executors();
    const rows = await Promise.all(targets.map(async m => {
      const unavailable = (reason: string) => ({ machineId: m.id, machineName: m.name, online: m.online, available: false, reason, sessions: [], roots: [], warnings: [], truncated: false });
      if (!m.online) return unavailable('电脑离线，历史记录尚未读取');
      if (!m.capabilities.includes('agents.sessions')) return unavailable('代理未提供会话发现，请升级电脑上的代理');
      try {
        const raw = await options.machines()!.call(m.id, 'agents.sessions', p?.workspace ? { roots: [p.workspace.cwd] } : {}, { timeoutMs: 30000 }) as unknown as AgentSessionDiscovery;
        if (!raw || !Array.isArray(raw.sessions) || !Array.isArray(raw.roots) || !Array.isArray(raw.warnings) || typeof raw.truncated !== 'boolean'
          || [...raw.roots, ...raw.warnings].some(item => typeof item !== 'string')) return unavailable('电脑返回的会话清单格式无效');
        const rawValues = raw.sessions.map(session);
        const values = task ? rawValues.filter(s => taskOwns(m.id, s)) : rawValues;
        if (p?.workspace && values.some(s => !within(p.workspace!.cwd, s.cwd))) return unavailable('电脑返回了项目目录范围外的会话，已拒绝');
        const ids = new Set(values.map(s => `${s.executorId}:${s.nativeSessionId}`));
        const recordedRuns = options.store.list<Run>('runs');
        const sessions = values.map(s => {
          const remoteExecutorId = `${m.id}/${s.executorId}`, executor = executors.find(e => e.id === remoteExecutorId);
          const resumable = m.capabilities.includes('executor.resume') && m.capabilities.includes('agents.session') && !!executor?.available && executor.mode === 'real' && nativeResultSources(executor).length > 0;
          const { parentNativeSessionId, ...value } = s;
          return { ...value, ...(parentNativeSessionId && ids.has(`${s.executorId}:${parentNativeSessionId}`) ? { parentNativeSessionId } : {}), machineId: m.id, remoteExecutorId, resumable,
            ...(!resumable ? { reason: !m.capabilities.includes('executor.resume') ? '代理不支持原生恢复，请升级' : executor?.reason || (executor?.available && !nativeResultSources(executor).length ? '该执行者尚未提供可验证的原生恢复能力' : '执行者不可用或插件未启用') } : {}),
            relatedRunIds: recordedRuns.filter(r => r.machineId === m.id && (r.nativeSessionId === s.nativeSessionId || r.nativeResume?.nativeSessionId === s.nativeSessionId) && r.executorId === remoteExecutorId && (!p || r.projectId === p.id)).map(r => r.id) };
        });
        return { machineId: m.id, machineName: m.name, online: true, available: true, roots: raw.roots, warnings: raw.warnings, truncated: raw.truncated, sessions };
      } catch (error) { return unavailable(error instanceof AgentSessionError ? error.message : '会话读取失败，不能推断电脑上没有会话'); }
    }));
    return { capturedAt: new Date().toISOString(), machines: rows };
  }
  async function validateExecution(params: JsonObject) {
    const spec = nativeResumeSpec(params.nativeResume);
    const id = text(params.executorId, '恢复执行者');
    const executor = options.executors().find(e => e.id === id);
    if (!executor || !executor.available || executor.mode !== 'real' || !nativeResultSources(executor).length || id !== `${executor.machineId}/${spec.executorId}`) return fail('原生恢复执行者不可用、插件未启用或类型不匹配', 409);
    const p = project(params.projectId);
    if (params.todoId) {
      const todo = options.store.get<Todo>('todos', text(params.todoId, '事项'));
      if (!todo || todo.completedAt || todo.projectId !== p?.id) return fail('事项已完成或归属改变，请重新确认恢复', 409);
    }
    const found = await lookup(executor.machineId, spec, text(params.cwd, '恢复目录'));
    if (found.cwd !== params.cwd) return fail('审批中的恢复目录已改变，请重新选择并确认', 409);
    allowedProject(p, executor.machineId, found.cwd);
    if (options.store.list<Run>('runs').some(r => r.machineId === executor.machineId && r.executorId === id && ['queued', 'running'].includes(r.status) && (r.nativeSessionId === spec.nativeSessionId || r.nativeResume?.nativeSessionId === spec.nativeSessionId))) return fail('此原生线程已有执行在运行，请先停止并核对原执行，不能重复恢复', 409);
    return found;
  }
  const requestKey = (machineId: string, key: string) => JSON.stringify([machineId, key]);
  function request(machineId: string, key: string) {
    const previous = options.store.get<{ signature: string; approvalId: string }>('native-resume.requests', requestKey(machineId, key));
    return previous ? options.store.get<Approval>('approvals', previous.approvalId) ?? null : null;
  }
  async function proposeResume(input: Record<string, unknown>, source?: Message) {
    if (!input || Object.keys(input).some(key => !['machineId', 'executorId', 'nativeSessionId', 'cwd', 'projectId', 'todoId', 'prompt', 'doneWhen', 'expectMinutes', 'key', 'executionMode'].includes(key))) return fail('恢复申请包含未知字段');
    if (source && (source.role !== 'user' || source.readOnly)) return fail('只读回报不能申请恢复', 403);
    const spec = nativeResumeSpec({ executorId: input.executorId, nativeSessionId: input.nativeSessionId });
    const machineId = text(input.machineId, '电脑'), key = text(input.key, '恢复请求标识');
    if (key.length > 200) return fail('恢复请求标识过长');
    const prompt = typeof input.prompt === 'string' && input.prompt.trim() && !input.prompt.includes('\0') ? input.prompt.trim() : fail('请填写继续工作的目标');
    const cwd = text(input.cwd, '恢复目录'), mode = input.executionMode ?? 'task';
    if (!['task', 'interactive'].includes(String(mode))) return fail('恢复模式无效');
    const doneWhen = typeof input.doneWhen === 'string' && !input.doneWhen.includes('\0') ? input.doneWhen.trim() : '';
    if (mode === 'task' && !doneWhen) return fail('请填写验收标准');
    const minutes = input.expectMinutes;
    if ((mode === 'task' || minutes !== undefined) && (typeof minutes !== 'number' || !Number.isFinite(minutes) || minutes <= 0 || minutes > 10080)) return fail('任务恢复需要有效的预计时长');
    let projectId = input.projectId ? text(input.projectId, '项目') : source?.projectId;
    const todoId = input.todoId ? text(input.todoId, '事项') : source?.todoId;
    if (todoId && !projectId) projectId = options.store.get<Todo>('todos', todoId)?.projectId;
    if (source?.conversationId !== 'main' && source?.projectId && projectId !== source.projectId) return fail('恢复申请不能跨当前项目范围', 403);
    if (source?.todoId && todoId !== source.todoId) return fail('恢复申请不能跨当前事项', 403);
    const normalized = { machineId, ...spec, cwd, prompt, doneWhen, mode, ...(minutes === undefined ? {} : { minutes }), ...(projectId ? { projectId } : {}), ...(todoId ? { todoId } : {}), ...(source ? { sourceId: source.id } : {}) };
    const signature = JSON.stringify(normalized), id = requestKey(machineId, key);
    const previous = options.store.get<{ signature: string; approvalId: string }>('native-resume.requests', id);
    if (previous) { if (previous.signature !== signature) return fail('同一恢复标识不能改变会话、来源或工作内容', 409); return request(machineId, key)!; }
    const remoteExecutorId = `${machineId}/${spec.executorId}`;
    if (source?.todoId && !options.store.list<Run>('runs').some(run => run.todoId === source.todoId && run.machineId === machineId && run.executorId === remoteExecutorId && (run.nativeSessionId === spec.nativeSessionId || run.nativeResume?.nativeSessionId === spec.nativeSessionId))) return fail('事项机器人只能恢复已关联本事项的原生线程，请由用户在Web明确分配', 403);
    options.pinExecutor?.(source, remoteExecutorId);
    const p = project(projectId); allowedProject(p, machineId);
    if (todoId) { const todo = options.store.get<Todo>('todos', todoId); if (!todo || todo.completedAt || todo.projectId !== projectId) return fail('事项不存在、已完成或不属于项目', 409); }
    const found = await lookup(machineId, spec, cwd);
    const params: JsonObject = { executorId: remoteExecutorId, cwd: found.cwd, nativeResume: { ...spec }, prompt, executionMode: String(mode), doneWhen, conversationId: source?.conversationId ?? 'main',
      ...(minutes === undefined ? {} : { expectMinutes: minutes }), ...(projectId ? { projectId } : {}), ...(todoId ? { todoId } : {}), ...(source ? { sourceMessageId: source.id } : {}) };
    await validateExecution(params);
    return options.store.transaction(() => {
      const raced = options.store.get<{ signature: string; approvalId: string }>('native-resume.requests', id);
      if (raced) { if (raced.signature !== signature) return fail('恢复请求冲突', 409); return request(machineId, key)!; }
      const approval = options.propose({ kind: 'dispatch', title: `恢复 ${spec.executorId} 原生会话`, details: `新建CLI进程续用历史线程，不是附着现有终端。请确认原会话已停止；原有unknown记录不会被自动重试或标记完成，本次是需要你单独批准的新请求。\n电脑：${machineId}\n线程：${spec.nativeSessionId}\n目录：${found.cwd}\n目标：${prompt}\n验收：${doneWhen}`, params, ...(todoId ? { todoId } : {}) });
      options.store.put('native-resume.requests', id, { signature, approvalId: approval.id }); return approval;
    });
  }
  return { discover, proposeResume, validateExecution, request };
}
