import { posix } from 'node:path';
import type { ExecutorInfo, MachineInfo, Project } from '../../../packages/protocol/src/index.ts';
import { cardDocument, cardPlain, cardSection } from './feishu-cards.ts';

export function startCardSnapshot(machines: MachineInfo[], executors: ExecutorInfo[], projects: Project[], pinnedExecutorId?: string) {
  const computers = new Map(machines.filter(machine => machine.online).map(machine => [machine.id, machine.name]));
  const available = executors.filter(executor => executor.available && (!pinnedExecutorId || executor.id === pinnedExecutorId)
    && (computers.has(executor.machineId) || executor.mode === 'demo'));
  const active = projects.filter(project => !project.archivedAt);
  return {
    executors: available.slice(0, 40).map(({ id, name, machineId, mode, taskOnly, defaultCwd }) => ({
      id, name, machineId, machineName: computers.get(machineId) ?? machineId, mode, taskOnly: Boolean(taskOnly), defaultCwd,
    })),
    projects: active.slice(0, 40).map(({ id, name, workspace }) => ({ id, name, workspace })),
    truncated: available.length > 40 || active.length > 40,
  };
}
export type StartCardSnapshot = ReturnType<typeof startCardSnapshot>;

const fieldLimit = 1000;
const noProject = '__global__';
function select(name: string, label: string, options: { label: string; id: string }[], initial?: string) {
  return { tag: 'select_static', name, width: 'fill', placeholder: cardPlain(label),
    ...(name === 'executorId' && { required: true }), ...(initial && { initial_index: options.findIndex(option => option.id === initial) + 1 }), options: options.map(option => ({ text: cardPlain(option.label), value: option.id })) };
}
function input(name: string, label: string, initial?: string, multiline = false) {
  return { tag: 'input', name, width: 'fill', label: cardPlain(label), label_position: 'top', max_length: fieldLimit,
    ...(name === 'prompt' && { required: true }), ...(initial && { default_value: initial }),
    ...(multiline && { input_type: 'multiline_text', rows: 2 }) };
}
const shortName = (name: string) => [...name.replace(/\s+/g, ' ').trim()].slice(0, 40).join('');

export function startCard(snapshot: StartCardSnapshot, navigation: string, prompt = '', projectId?: string) {
  const title = '发起执行';
  if (!snapshot.executors.length || (projectId && !snapshot.projects.some(project => project.id === projectId)) || [...prompt].length > fieldLimit) {
    const text = !snapshot.executors.length ? '当前没有可用执行者。请在 Web 的 Agent 页面核对电脑连接和执行器。'
      : [...prompt].length > fieldLimit ? '目标超过飞书表单的 1000 字限制，请缩短目标或在 Web 发起执行。'
      : '当前项目未出现在这次表单的项目清单，请到 Web 项目工作区发起执行。';
    return { card: cardDocument(title, cardSection(title, text)), text };
  }
  const text = '确认目标后点击「发起执行」会立即派发。演示执行者只运行本地演示。'
    + (snapshot.truncated ? '\n选项较多，表单仅列出前 40 项。其他选项可在 Web 发起执行。' : '');
  const fields = [
    select('projectId', '归属项目', [{ id: noProject, label: '未归项目' }, ...snapshot.projects.map(p => ({ id: p.id, label: shortName(p.name) }))], projectId || noProject),
    select('executorId', '选择电脑和执行者', snapshot.executors.map(e => ({ id: e.id,
      label: [shortName(e.machineName), shortName(e.name), e.mode === 'demo' ? '演示' : '真实执行'].join(' · ') }))),
    select('executionMode', '执行方式', [{ id: 'task', label: '任务' }, { id: 'interactive', label: '交互会话' }], snapshot.executors.some(executor => !executor.taskOnly) ? 'interactive' : 'task'),
    input('cwd', '工作目录（绝对路径；留空使用项目或执行者默认目录）'),
    input('prompt', '执行目标', prompt, true),
    input('doneWhen', '验收标准（真实任务必填）', undefined, true),
    input('minutes', '预计分钟数（真实任务必填，最多 10080）'),
    { tag: 'button', name: 'submit_start', text: cardPlain('发起执行'), type: 'primary', form_action_type: 'submit',
      behaviors: [{ type: 'callback', value: { kind: 'workbench.startSubmit', navigation } }] },
  ];
  const card = { schema: '2.0', header: { template: 'blue', title: cardPlain(title) }, body: { elements: [
    { tag: 'div', text: cardPlain(text) }, { tag: 'form', name: 'start', elements: fields },
  ] } };
  return { card, text };
}

export function parseStartForm(snapshot: StartCardSnapshot, form: Record<string, unknown>) {
  function read(name: string) {
    const value = form[name];
    if (value === undefined || value === null) return '';
    if (typeof value !== 'string' || [...value].length > fieldLimit || /\0/u.test(value)) throw new Error('表单字段格式无效或超过 1000 字');
    return value.trim();
  }
  const executorId = read('executorId');
  const executor = snapshot.executors.find(item => item.id === executorId);
  if (!executor) throw new Error('请选择表单中当前可用的执行者');
  const selection = read('projectId'), projectId = selection && selection !== noProject ? selection : undefined;
  const project = projectId ? snapshot.projects.find(item => item.id === projectId) : undefined;
  if (projectId && !project) throw new Error('所选项目已不可用，请重新打开发起执行表单');
  const workspace = project?.workspace;
  if (workspace && (workspace.machineId !== executor.machineId || executor.mode !== 'real')) throw new Error('请选择项目绑定电脑上的真实执行者');
  const requestedCwd = read('cwd');
  if (requestedCwd && (!posix.isAbsolute(requestedCwd) || /[\p{Cc}]/u.test(requestedCwd) || requestedCwd.split('/').includes('..'))) throw new Error('工作目录需要有效的绝对路径');
  if (workspace && requestedCwd && requestedCwd !== workspace.cwd) throw new Error('项目已绑定工作目录，请使用项目目录');
  const cwd = requestedCwd || workspace?.cwd || executor.defaultCwd;
  if (executor.mode === 'real' && !cwd) throw new Error('所选电脑未提供默认工作目录，请填写绝对路径');
  const prompt = read('prompt');
  if (!prompt) throw new Error('请填写执行目标');
  const executionMode = read('executionMode') || (snapshot.executors.some(item => !item.taskOnly) ? 'interactive' : 'task');
  if (executionMode !== 'task' && executionMode !== 'interactive') throw new Error('请选择有效的执行方式');
  if (executor.taskOnly && executionMode === 'interactive') throw new Error('所选执行者只支持任务模式');
  const doneWhen = read('doneWhen'), minutes = read('minutes');
  const expectMinutes = minutes ? Number(minutes) : undefined;
  if (expectMinutes !== undefined && (!/^\d+(\.\d+)?$/.test(minutes) || !Number.isFinite(expectMinutes) || expectMinutes <= 0 || expectMinutes > 10080))
    throw new Error('预计用时必须为不超过 10080 的正数分钟');
  if (executor.mode === 'real' && executionMode === 'task' && (!doneWhen || !expectMinutes)) throw new Error('真实任务需要验收标准和预计用时');
  return { executorId: executor.id, machineId: executor.machineId, ...(projectId && { projectId }), ...(cwd && { cwd }), prompt,
    executionMode: executionMode as 'task' | 'interactive', ...(doneWhen && { doneWhen }), ...(expectMinutes && { expectMinutes }) };
}
