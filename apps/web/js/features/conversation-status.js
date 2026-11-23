import { h, replace } from '../lib/dom.js';
import { Button } from '../ui/kit.js';
import { openDrawer } from '../ui/overlay.js';
import { conversationSearchActive } from './search.js';

const phases = { no_records: '暂无会话记录', idle: '当前无待处理回合', working: '正在处理', waiting: '等待决定', failed: '处理失败', unknown: '状态尚未核实' };
const kinds = { question: '问题', permission: '权限', plan: '计划', review: '验收' };

export function conversationStatusButton({ api, store, scope, target, project, todo = () => '' }) {
  const button = Button({ label: '会话状态', size: 'sm', onClick: open });
  const enabled = () => !store.view.unauthorized && conversationSearchActive(store.view.snapshot);
  function update() { button.hidden = !enabled(); }
  store.subscribe(update);
  update();

  function open() {
    if (!enabled()) return;
    const projectId = project() || undefined, todoId = todo() || undefined;
    const owner = api.draftOwner(), route = location.hash;
    const title = store.view.snapshot.projects.find(p => p.id === projectId)?.name;
    const content = h('div', { class: 'stack' });
    const controller = new AbortController();
    const valid = () => enabled() && owner === api.draftOwner() && route === location.hash &&
      (project() || undefined) === projectId && (todo() || undefined) === todoId &&
      (!projectId || store.view.snapshot.projects.some(p => p.id === projectId && !p.archivedAt)) &&
      (!todoId || store.view.snapshot.todos.some(t => t.id === todoId && t.projectId === projectId));
    const drawer = openDrawer({ title: '会话状态', subtitle: [target === 'main' ? '主对话' : '项目工作对话', title].filter(Boolean).join(' · '),
      body: content, footer: Button({ label: '刷新状态', onClick: read }), onClose() {
        controller.abort(); unsubscribe(); offScope();
      } });
    const dismiss = () => { if (!valid()) drawer.close(); };
    const unsubscribe = store.subscribe(dismiss), offScope = scope.subscribe(dismiss);
    let sequence = 0;
    async function read() {
      const stamp = ++sequence;
      const current = () => stamp === sequence && drawer.el.open && valid();
      replace(content, h('p', { role: 'status' }, '正在读取会话状态…'));
      try {
        const data = await api('/conversation-status', { method: 'POST', body: { target, projectId, todoId }, signal: controller.signal });
        if (!current()) return;
        const last = data.lastMessage;
        replace(content, h('strong', null, phases[data.phase] || phases.unknown),
          data.goal && h('p', null, '当前执行目标 · ' + data.goal),
          last && h('section', { class: 'stack' }, h('h3', null, '最近发言'), h('p', { class: 'small muted' }, (last.role === 'user' ? '用户' : last.status === 'pending' ? '助手 · 处理中' : last.status === 'failed' ? '助手 · 处理失败' : '助手') + ' · ' + last.at),
            h('p', null, last.text), last.truncated && h('p', { class: 'small muted' }, '仅显示摘录')),
          h('section', { class: 'stack' }, h('h3', null, '待决定 · ' + data.pending.total),
            data.pending.items.map(item => h('p', null, (kinds[item.kind] || item.kind) + ' · ' + item.title)),
            data.pending.truncated && h('p', { class: 'small muted' }, '仅显示部分待决定事项')));
      } catch (error) {
        if (current()) replace(content, h('p', { role: 'alert' }, error.message));
      }
    }
    void read();
  }
  return button;
}
