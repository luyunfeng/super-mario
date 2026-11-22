import { h, replace } from '../lib/dom.js';
import { Button, Pill } from '../ui/kit.js';

const sources = { codex: 'Codex', 'claude-code': 'Claude Code', shared: '共享目录' };

export function createMachineSkills({ api, machineId, state, active }) {
  const result = h('div', { class: 'stack', 'aria-live': 'polite' });
  const actions = h('div');
  const el = h('section', { class: 'stack', 'aria-label': '执行机技能', hidden: true },
    h('h3', null, '执行机技能'), h('p', { class: 'muted small' }, '只读查看这台执行机本地发现的技能。主助手已安装的技能可在 Agent 页的「助手技能」中查看。'), actions, result);
  let context, version = 0;

  function update() {
    const snapshot = state();
    const plugin = snapshot?.plugins?.find(item => item.id === 'assistant-skills');
    const machine = snapshot?.machines?.find(item => item.id === machineId);
    let reason = '';
    if (!plugin) reason = '工作台未提供助手技能插件。';
    else if (plugin.status === 'disabled') reason = '助手技能插件已停用。';
    else if (plugin.status !== 'active') reason = '助手技能插件不可用。';
    else if (typeof machine?.online !== 'boolean') reason = '执行机连接状态未知。';
    else if (!machine.online) reason = '执行机离线，技能清单未知。';
    else if (!machine.capabilities?.includes('skills.catalog')) reason = '当前代理不支持读取技能清单。';

    // 重新连接的代理可能已更换目录，旧清单和在途响应都不能跨越这次连接。
    const next = JSON.stringify([reason, machine?.connectedAt, machine?.agentInstanceId]);
    if (context === next) return;
    context = next;
    version++;
    el.hidden = !plugin;
    replace(actions, !reason && Button({ label: '查看技能清单', size: 'sm', onClick: load }));
    replace(result, reason && h('p', { class: 'muted small' }, reason));
  }

  async function load() {
    if (!active()) return;
    const order = version;
    update();
    if (order !== version) return;
    const stamp = ++version;
    const valid = () => {
      if (!active()) return false;
      update();
      return stamp === version;
    };
    replace(result, h('p', { class: 'small muted' }, '正在读取技能清单…'));
    try {
      const data = await api.get('/machines/' + encodeURIComponent(machineId) + '/skills');
      if (!valid()) return;
      if (!Array.isArray(data?.skills) || typeof data.truncated !== 'boolean' ||
        !data.skills.every(skill => skill && typeof skill.name === 'string' && typeof skill.description === 'string' && Object.hasOwn(sources, skill.source))) {
        throw new Error('invalid-response');
      }
      replace(result, !data.skills.length && h('p', { class: 'muted small' }, '这台执行机没有报告技能。'),
        data.skills.map(skill => h('div', { class: 'item' }, h('div', { class: 'item__main' },
          h('strong', { class: 'item__title' }, skill.name), h('span', { class: 'item__meta' }, skill.description)), Pill(sources[skill.source]))),
        data.truncated && h('p', { class: 'muted small' }, '清单已截断，仅显示代理返回的技能。'));
    } catch (error) {
      if (!valid()) return;
      const reason = [401, 403].includes(error.status) ? '当前凭据无权访问。'
        : [404, 405, 501].includes(error.status) ? '当前服务或执行机未提供清单。' : '';
      replace(result, h('p', { role: 'alert', class: 'text-danger small' }, '读取失败，技能清单未知。' + reason));
    }
    replace(actions, Button({ label: '重新读取技能清单', size: 'sm', onClick: load }));
  }
  return { el, update };
}
