import type { ExtensionContext, Json, MachineClient } from '../packages/plugin-sdk/src/index.ts';

function fail(status: number, message: string): never {
  throw Object.assign(new Error(message), { status });
}

/** The node chooses the roots. Only the inventory fields cross the server boundary. */
export function registerMachineSkillCatalog(context: ExtensionContext, getMachines: () => MachineClient | undefined) {
  async function read(input: Json) {
    if (!input || typeof input !== 'object' || Array.isArray(input) || typeof input.machineId !== 'string'
      || !input.machineId.trim() || Object.keys(input).length !== 1) fail(400, '请选择一台执行机');
    const machines = getMachines();
    if (!machines) fail(503, '执行机网关尚未连接');
    const machine = machines.list().find(item => item.id === input.machineId);
    if (!machine) fail(404, '执行机不存在');
    if (!machine.online) fail(503, '执行机离线');
    if (!machine.capabilities.includes('skills.catalog')) fail(409, '请升级执行机代理以读取技能清单');
    const data = await machines.call(machine.id, 'skills.catalog', {});
    if (!data || typeof data !== 'object' || Array.isArray(data) || !Array.isArray(data.skills) || data.skills.length > 512
      || typeof data.truncated !== 'boolean') fail(502, '执行机返回的技能清单无效');
    const skills = data.skills.map(item => {
      if (!item || typeof item !== 'object' || Array.isArray(item) || typeof item.name !== 'string' || !item.name
        || item.name.length > 256 || typeof item.description !== 'string' || item.description.length > 1024
        || typeof item.source !== 'string' || !['shared', 'codex', 'claude-code'].includes(item.source)) fail(502, '执行机返回的技能条目无效');
      return { name: item.name, description: item.description, source: item.source };
    });
    return { skills, truncated: data.truncated };
  }

  context.provide('assistant-skills.machine-catalog', read);
  context.contribute('tools', 'machine_skills_list', {
    name: 'machine_skills_list', description: '只读查询指定执行机的本地技能名称、简介和来源。截断时可按 nextOffset 续读已发现条目。扫描不启动 CLI，也不能证明技能可执行。',
    parameters: { type: 'object', properties: { machineId: { type: 'string' }, offset: { type: 'integer', minimum: 0 } },
      required: ['machineId'], additionalProperties: false },
    async execute(args, signal) {
      signal.throwIfAborted();
      const { offset = 0, ...input } = args;
      if (typeof offset !== 'number' || !Number.isSafeInteger(offset) || offset < 0) fail(400, '清单偏移无效');
      const { skills, truncated } = await read(input);
      signal.throwIfAborted();
      if (offset > skills.length) fail(409, '技能清单已变化，请从头读取');
      const page = skills.slice(offset, offset + 12);
      return { skills: page, truncated, nextOffset: offset + page.length < skills.length ? offset + page.length : null };
    },
  });
}
