// 电脑：添加电脑的说明，以及查看某台电脑上的终端。底层的运行时和连接方式不出现在界面里。
import { h, replace } from '../lib/dom.js';
import { Button, Pill, Empty, copyText } from '../ui/kit.js';
import { openDrawer } from '../ui/overlay.js';
import { createMachineSkills } from './machine-skills.js';
import { agentDiagnostics, recoverySummary, recoveryUnavailable, legacyRecovery, unsupportedApi } from './agent-diagnostics.js';
import { machineStorage } from './machine-storage.js';

let currentComputer;

export function openAddComputer({ api }) {
  const command = `SUPER_MARIO_TOKEN=${api.token() ? '你的访问令牌' : '（本机服务可不填）'} super-mario-agent --url ${location.origin}`;
  openDrawer({
    title: '添加电脑', subtitle: '让一台电脑成为 Agent 的执行者',
    body: h('div', { class: 'stack stack--lg' },
      h('ol', { class: 'howto' },
        h('li', null, h('strong', null, '安装'), h('p', { class: 'muted small' }, '在要执行任务的电脑上安装 Super Mario，并确保能运行 Claude Code 或 Codex。')),
        h('li', null, h('strong', null, '登录'), h('p', { class: 'muted small' }, '先在那台电脑上登录 Claude Code 或 Codex。连接后可手动检查本地凭证；检查不证明模型调用成功。')),
        h('li', null, h('strong', null, '连接'), h('p', { class: 'muted small' }, '在那台电脑上运行下面的命令。连上后它会出现在“执行者与电脑”里。'))),
      h('p', { class: 'muted small' }, '自定义启动器或配置目录：在执行机运行 super-mario-agent --help 查看 --codex-command、--codex-config-dir、--claude-command、--claude-config-dir。修改执行机的启动命令后重新连接；此处不会远程修改配置。'),
      h('div', { class: 'stack' }, h('pre', { class: 'codebox' }, command),
        Button({ label: '复制命令', icon: 'copy', size: 'sm', onClick: async (event, el) => { await copyText(command); el.lastChild.textContent = '已复制'; } }))),
  });
}

/** 某台电脑的详情：可用的执行者，以及这台电脑上的终端（只读观察，或打开已绑定的执行会话）。 */
export function openComputer({ api, machine, state, consoleDrawer }) {
  currentComputer?.close();
  let seq = 0, drawer, timer;
  const token = api.token();
  const active = () => {
    if (api.token() !== token) { drawer?.close(); return false; }
    return Boolean(drawer?.el.open && currentComputer === drawer);
  };
  const skills = createMachineSkills({ api, machineId: machine.id, state, active });
  // The storage panel follows the computer's state, as the skills do, so that its button
  // goes out as soon as the computer is offline and not only after a failed read.
  const storage = machineStorage({ api, machine, active, online: () => {
    const current = state()?.machines?.find(item => item.id === machine.id);
    return current ? current.online === true : machine.online === true;
  } });
  const connection = h('dd', null, machine.online ? '在线' : '离线');
  const recovery = h('p', { class: 'muted small', role: 'status' });
  const list = h('div', { class: 'stack' });
  const body = h('div', { class: 'stack stack--lg' },
    h('dl', { class: 'kv' },
      h('dt', null, '状态'), connection,
      h('dt', null, '系统'), h('dd', null, machine.platform || '未知')),
    h('div', { class: 'stack' }, h('h3', null, '执行者'),
      (machine.executors ?? []).length
        ? (machine.executors).map(item => h('div', { class: 'row row--between' }, h('span', null, item.name), Pill(item.available ? '可用' : '不可用', item.available ? 'ok' : 'warn')))
        : h('p', { class: 'muted small' }, '这台电脑还没有报告可用的执行者。')),
    skills.el,
    agentDiagnostics({ api, machine, active }),
    storage.el,
    h('div', { class: 'stack' }, h('h3', null, '恢复状态'), recovery),
    h('div', { class: 'stack' }, h('h3', null, '终端'), list));
  drawer = openDrawer({ title: machine.name, subtitle: '电脑详情', body, onClose: () => { seq++; clearInterval(timer); } });
  currentComputer = drawer;
  skills.update();
  timer = setInterval(() => {
    if (!active()) return;
    skills.update();
    storage.update();
    const machines = state()?.machines;
    if (!machines) return;
    const online = machines.find(item => item.id === machine.id)?.online;
    const label = typeof online === 'boolean' ? (online ? '在线' : '离线') : '未知';
    if (connection.textContent !== label) connection.textContent = label;
  }, 250);
  const recoveryRead = !machine.online ? Promise.resolve(null) : machine.capabilities?.includes('executor.recovery')
    ? api.get(`/machines/${encodeURIComponent(machine.id)}/recovery`).then(data => {
      if (!active()) return null;
      recovery.textContent = recoverySummary(data); return data;
    }).catch(error => { if (active()) recovery.textContent = unsupportedApi(error) ? legacyRecovery : recoveryUnavailable; return null; })
    : Promise.resolve(null);
  recovery.textContent = !machine.online ? '代理离线，恢复状态未知。' : machine.capabilities?.includes('executor.recovery') ? '正在读取恢复说明…' : legacyRecovery;
  async function loadTerminals() {
    const stamp = ++seq;
    replace(list, h('p', { class: 'muted small' }, '正在读取终端…'));
    try {
      const [panes, sessions, recoveryData] = await Promise.all([
        api.post(`/machines/${encodeURIComponent(machine.id)}/call`, { method: 'terminal.list', params: {} }),
        api.get(`/machines/${encodeURIComponent(machine.id)}/sessions`), recoveryRead,
      ]);
      if (stamp !== seq || !active()) return;
      if (!panes.length) { replace(list, h('p', { class: 'muted small' }, '这台电脑当前没有打开的终端。')); return; }
      replace(list, panes.map((pane) => {
        const binding = sessions.find(item => item.paneId === pane.id);
        const run = binding && state().runs.find(item => item.machineId === machine.id && item.sessionId === binding.sessionId);
        const restored = recoveryData?.sessions?.find(item => item.paneId === pane.id && item.origin === 'restored');
        return h('div', { class: 'item' },
          h('div', { class: 'item__main' }, h('span', { class: 'item__title' }, pane.title || '未命名终端'), h('span', { class: 'item__meta mono' }, pane.cwd)),
          Button({ label: run ? '打开会话' : restored && restored.canObserve !== true ? '旧绑定不可观察' : '只读观察', size: 'sm', disabled: !run && Boolean(restored && restored.canObserve !== true), onClick: () => { drawer.close(); return run ? consoleDrawer.open(run) : consoleDrawer.openPane({ machineId: machine.id, paneId: pane.id, title: pane.title, cwd: pane.cwd }); } }));
      }));
    } catch (error) { if (stamp === seq && active()) replace(list, h('p', { class: 'text-danger small' }, '无法读取终端，状态未知。')); }
  }
  if (machine.online) loadTerminals(); else replace(list, Empty({ text: '电脑离线，无法读取终端。' }));
}
