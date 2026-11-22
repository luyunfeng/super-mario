// 项目工作对话复用真实隔离会话。快照只更新消息区，草稿按项目留在内存。
import { h, replace, keyedList } from '../lib/dom.js';
import { agentProgress } from '../ui/agent-progress.js';
import { renderFormattedText } from '../lib/markdown.js';
import { Button, Banner, Empty, TextArea } from '../ui/kit.js';
import { createCodeSidebar } from './code-sidebar.js';
import { attachSavedPrompts } from './saved-prompts.js';
import { createProjectInstructions } from './project-instructions.js';
import { createMessageFavorites } from './message-favorites.js';
import { createConversationExport } from './conversation-export.js';

export function createProjectConversation({ api, store, bindFolder }) {
  const code = createCodeSidebar({ api, store });
  let projectId = '';
  const instructions = createProjectInstructions({ api, store, getProjectId: () => projectId });
  const favorites = createMessageFavorites({ api, store });
  const transcript = createConversationExport({ api, store, getProjectId: () => projectId });
  let generation = 0;
  let request = 0;
  const drafts = new Map();
  const pending = new Set();
  const unknown = new Set();
  const notices = new Map();
  let workspace;
  const status = h('div', { 'aria-live': 'polite' });
  const progress = h('p', { class: 'muted small' });
  const messages = h('div', { class: 'project-conversation__messages', role: 'log', 'aria-label': '项目对话' });
  const text = TextArea({ rows: 3, placeholder: '告诉我这个文件夹里要做什么，我们持续推进。', 'aria-label': '项目目标' });
  const prompts = attachSavedPrompts({ api, store, input: text, getScope: () => projectId });
  text.addEventListener('input', () => drafts.set(projectId, text.value));
  text.addEventListener('keydown', (event) => {
    if (!event.defaultPrevented && event.key === 'Enter' && (event.ctrlKey || event.metaKey) && !event.isComposing) {
      event.preventDefault();
      void submit();
    }
  });
  const send = Button({ label: '发送目标', kind: 'primary', onClick: submit });
  const notice = h('div', { 'aria-live': 'polite' });
  const composer = h('div', { class: 'project-conversation__composer stack' }, prompts.menu, text, h('div', { class: 'row row--between row--wrap' }, h('span', { class: 'muted small' }, '项目工作会话持续保留上下文。'), prompts.manage, send), notice);
  const el = h('div', { class: 'project-conversation code-conversation', id: 'panel-workspace', role: 'tabpanel' }, h('div', { class: 'stack code-conversation__main' }, h('div', { class: 'row row--between row--wrap' }, progress, h('div', { class: 'row row--wrap' }, instructions.button, favorites.button, transcript.button, code.toggle)), status, messages, composer), code.el);
  let credential = api.token(), identity = 0;
  store.subscribe(() => {
    if (credential === api.token()) return;
    credential = api.token(); identity++; generation++; request++;
    workspace = undefined;
    drafts.clear(); pending.clear(); unknown.clear(); notices.clear();
    text.value = '';
  });
  const project = () => store.view.snapshot?.projects?.find(p => p.id === projectId);

  function paint() {
    instructions.update();
    code.show(projectId);
    const p = project();
    const machine = store.view.snapshot?.machines?.find(m => m.id === p?.workspace?.machineId);
    const work = workspace?.agents?.work;
    replace(status, !p?.workspace ? Banner({ tone: 'warn', children: '这个项目还没有绑定文件夹。已有对话、待办和资料会保留。', action: Button({ label: '绑定文件夹', size: 'sm', onClick: () => bindFolder(p) }) })
      : !machine?.online ? Banner({ tone: 'warn', children: '绑定电脑离线。对话记录保留，文件夹是否存在尚未验证。' })
        : work?.available === false ? Banner({ tone: 'warn', children: work.reason || '项目工作会话暂不可用，请检查模型配置。' }) : null);
    progress.textContent = workspace?.progress ? `待办 ${workspace.progress.open ?? 0} · 正在执行 ${workspace.progress.running ?? 0} · 待核对 ${workspace.progress.review ?? 0}` : '';
    send.disabled = !p?.workspace || pending.has(projectId) || unknown.has(projectId) || !workspace || work?.available === false;
    replace(notice, notices.get(projectId) ? Banner({ tone: 'warn', children: notices.get(projectId) }) : null);
    const rows = workspace?.messages ?? [];
    if (!rows.length) { replace(messages, Empty({ title: workspace ? '在这个文件夹里持续工作' : '正在读取项目对话…', text: workspace ? '直接输入目标，项目工作会话负责拆解并跟进。' : undefined })); messages._keyed = undefined; return; }
    if (!messages._keyed) messages.replaceChildren();
    keyedList(messages, rows, m => m.id, m => {
      const user = m.role === 'user';
      const statusText = { failed: '处理失败，请查看原因', unknown: '结果未知，请核对，勿重复发送', pending: '处理中' }[m.status];
      return h('div', { class: 'msg msg--' + (user ? 'user' : 'assistant') },
        h('div', { class: 'msg__col' },
          h('span', { class: 'msg__label' }, user ? '我' : '项目助手'),
          agentProgress(m),
          h('div', { class: 'msg__bubble' }, user ? m.text : renderFormattedText(m.text)),
          statusText && h('span', { class: 'msg__meta' }, statusText),
          h('span', null, favorites.mark(m, projectId), prompts.fromMessage(m))));
    }, m => JSON.stringify([prompts.epoch, favorites.epoch, projectId, m]));
  }
  async function load() {
    if (!projectId || projectId === 'all') return;
    const id = projectId, stamp = generation, order = ++request;
    try {
      const value = await api.get(`/projects/${encodeURIComponent(id)}/workspace`);
      if (stamp !== generation || order !== request) return;
      workspace = value;
      paint();
    } catch (error) {
      if (stamp !== generation || order !== request) return;
      replace(notice, Banner({ tone: 'danger', children: `无法读取项目对话：${error.message}` }));
    }
  }
  async function submit() {
    const id = projectId, stamp = generation, sender = identity, draft = text.value;
    if (send.disabled || !draft.trim()) return;
    pending.add(id); notices.delete(id); paint();
    try {
      const answer = await api.post(`/projects/${encodeURIComponent(id)}/messages`, { text: draft.trim() });
      if (sender !== identity) return;
      if (answer?.status === 'unknown') { unknown.add(id); notices.set(id, '处理结果未知，请先核对项目对话和执行记录，勿重复发送。'); }
      if (drafts.get(id) === draft) drafts.delete(id);
      if (stamp === generation) { if (text.value === draft) text.value = ''; await load(); }
      void store.refresh().catch(() => {});
    } catch (error) {
      if (sender !== identity) return;
      if (!error.status || error.status >= 500 || /unknown/i.test(error.message)) {
        unknown.add(id);
        notices.set(id, '发送结果未知，请先核对项目对话和执行记录；本页不会重复发送。');
      } else notices.set(id, `发送被拒绝：${error.message}`);
    } finally { if (sender === identity) pending.delete(id); if (stamp === generation) paint(); }
  }
  return {
    el,
    show(id) {
      if (projectId !== id) {
        instructions.close();
        prompts.changeScope();
        transcript.close();
        if (projectId) drafts.set(projectId, text.value);
        generation++; request++; projectId = id; workspace = undefined; text.value = drafts.get(id) ?? '';
      }
      paint(); void load();
    },
    update() { paint(); void load(); },
  };
}
