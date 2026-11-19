import { h, replace } from '../lib/dom.js';
import { Banner, Button, Card, Field, Pill, Select } from '../ui/kit.js';

const endpoint = '/feishu/command-group';
const groupLabels = {
  not_created: '尚未创建', ready: '已就绪', partial: '部分成员未就绪', failed: '操作失败', unknown: '结果待核对',
};
const memberLabels = { joined: '已加入', failed: '加入失败', unknown: '加入结果未知' };

export function createCommandGroupCard({ api, store }) {
  const body = h('div', { class: 'stack' });
  const el = Card({ id: 'agent-command-group', title: '飞书总指挥群',
    sub: '只有已入群且已配对的项目机器人才能处理任务。在群里 @ 其中一个，任务就交给对应项目。没有 @ 机器人时，由主 Agent 识别消息属于哪个项目。',
    body: [h('p', { class: 'small muted' }, '要处理无人 @ 的消息，请为主机器人开通接收群内全部消息的权限，并发布新版本。项目机器人可继续只接收群内 @ 自己的消息。'), body],
  });
  let group, candidates, selected = '', error = '', pending = '', version = 0;
  let credential = api.token();

  function paint() {
    const reading = pending === 'read', writing = pending === 'write';
    const retry = group && ['partial', 'failed', 'unknown'].includes(group.status);
    const needsMain = group && !group.chatId && !group.mainBotId;
    const choose = needsMain && candidates?.length > 1;
    const submit = Button({
      label: writing ? '正在提交…' : retry ? '重试' : group?.chatId ? '同步成员' : '创建总指挥群',
      kind: 'primary', size: 'sm', onClick: () => request('write'),
      disabled: !!pending || !!error || (retry && !group.canRetry) || (needsMain && (!candidates?.length || (choose && !selected))),
    });
    const select = choose && Select({
      'aria-label': '主机器人', options: [['', '请选择主机器人'], ...candidates.map(bot => [bot.id, bot.name])],
      value: selected, disabled: !!pending,
    });
    if (select) select.addEventListener('change', () => { selected = select.value; paint(); });
    const projects = store.view.snapshot?.projects ?? [];
    replace(body,
      group && h('p', { class: 'small', role: 'status' }, groupLabels[group.status], group.chatId && ' · 群 ID：' + group.chatId),
      group?.reason && Banner({ tone: 'warn', children: group.reason }),
      group && group.members.length > 0 && h('ul', { class: 'list', 'aria-label': '群成员状态' }, group.members.map(member =>
        h('li', { class: 'item' }, h('div', { class: 'item__main' },
          h('strong', null, member.name),
          h('span', { class: 'item__meta' }, member.botId === group.mainBotId ? '主机器人' : projects.find(p => p.id === member.projectId)?.name ?? member.projectId),
          member.reason && h('p', { class: 'small' }, member.reason)),
        Pill(memberLabels[member.status] ?? '状态待核对', member.status === 'joined' ? 'ok' : 'warn')))),
      error && Banner({ tone: 'danger', children: error }),
      needsMain && candidates?.length === 0 && h('p', { class: 'small muted' }, '请先配置并启用主 Agent 的全局飞书机器人。'),
      select && Field({ label: '用于建群的全局机器人', control: select }),
      h('div', { class: 'row row--wrap' }, group && submit,
        Button({ label: reading ? '正在读取…' : '刷新群状态', size: 'sm', disabled: !!pending, onClick: () => request('read') })));
  }

  async function request(action) {
    if (pending === 'write' || (action === 'write' && pending)) return;
    const stamp = ++version, token = api.token();
    const selectMain = action === 'write' && !group.chatId && !group.mainBotId && candidates?.length > 1;
    error = ''; pending = action; paint();
    try {
      const result = action === 'read' ? await api.get(endpoint) : await api.post(endpoint, selectMain ? { mainBotId: selected } : {});
      if (stamp !== version || token !== api.token()) return;
      if (!Object.hasOwn(groupLabels, result?.status) || !Array.isArray(result.members)) throw new Error('服务端返回了无法识别的群状态');
      group = result;
    } catch (cause) {
      if (stamp !== version || token !== api.token()) return;
      if (action === 'read') error = '读取群状态失败：' + cause.message;
      else if (cause.status >= 400 && cause.status < 500) error = '请求被拒绝：' + cause.message;
      else error = '提交未确认，请刷新群状态后核对。' + cause.message;
    } finally {
      if (stamp === version) { pending = ''; paint(); }
    }
  }
  return {
    el,
    load() {
      if (credential !== api.token()) {
        version++; credential = api.token(); group = undefined; candidates = undefined; selected = ''; pending = '';
      }
      return request('read');
    },
    setMainBots(bots) {
      candidates = bots?.filter(bot => bot.enabled && bot.configured);
      if (!candidates?.some(bot => bot.id === selected)) selected = '';
      paint();
    },
  };
}
