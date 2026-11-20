import { h, keyedList, replace } from '../lib/dom.js';
import { agentProgress } from '../ui/agent-progress.js';
import { openDrawer } from '../ui/overlay.js';

const states = { idle: '空闲', waiting: '等待模型配置', queued: '排队中', running: '整理中', completed: '已整理', failed: '整理失败', unknown: '结果待核对' };
export const memoryStatus = status => states[status] ?? status;

function renderMessage(message) {
  const title = message.role === 'user' ? '整理请求' : '整理回复';
  return h('article', { class: 'stack' },
    h('div', { class: 'row row--wrap' }, h('strong', null, title), h('time', { class: 'small muted', dateTime: message.createdAt }, new Date(message.createdAt).toLocaleString())),
    agentProgress(message),
    h('details', { open: message.role === 'assistant' }, h('summary', null, message.role === 'user' ? '查看请求原文' : '回复内容'),
      h('div', { style: { whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' } }, message.text)));
}

export function openProjectMemory(api, projectId, projectName) {
  const status = h('p', { role: 'status' }, '正在读取…');
  const result = h('div', { class: 'stack' });
  const history = h('div', { class: 'stack stack--lg', 'aria-label': '最近 60 条会话消息' });
  let timer;
  const drawer = openDrawer({ title: '记忆整理会话', subtitle: projectName, body: [status, result, history], onClose: () => clearTimeout(timer) });
  async function refresh() {
    try {
      const data = await api.get(`/projects/${encodeURIComponent(projectId)}/memory`);
      if (!drawer.el.open) return;
      status.textContent = [memoryStatus(data.status), data.attemptAt && `最近开始 ${new Date(data.attemptAt).toLocaleString()}`, data.updatedAt && `最近写入 ${new Date(data.updatedAt).toLocaleString()}`].filter(Boolean).join(' · ');
      replace(result, data.error && h('p', { role: 'alert' }, data.error),
        data.summary && h('p', null, data.summary),
        !data.messages.length && h('p', { class: 'muted' }, data.mode === 'demo' ? '演示整理未调用模型，没有会话消息。' : '暂无整理会话消息。'));
      keyedList(history, data.messages, m => m.id, renderMessage);
    } catch (error) {
      if (drawer.el.open) status.textContent = `无法读取最新整理记录：${error.message}`;
    } finally {
      if (drawer.el.open) timer = setTimeout(refresh, 3000);
    }
  }
  void refresh();
}
