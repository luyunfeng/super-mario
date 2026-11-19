// 对话：主页。顶部是“等你处理”，中间是消息流，输入框固定在底部。
import { h, keyedList, replace } from '../lib/dom.js';
import { timeAgo } from '../lib/format.js';
import { renderFormattedText } from '../lib/markdown.js';
import { icon } from '../ui/icons.js';
import { Button, Banner, Card, Pill } from '../ui/kit.js';
import { Hint, hintCopy } from '../ui/hint.js';
import { createAttention } from '../features/attention.js';
import { createCodeSidebar } from '../features/code-sidebar.js';
import { createRecentWork } from '../features/recent-work.js';
import { systemText } from '../copy/terms.js';

const EXAMPLES = ['梳理本周待办，给我下一步建议', '检查正在执行的任务进展', '把官网首页的报错修一下'];

const SETUP_STEPS = [
  { key: 'agent', title: '配置 Agent', desc: '选一个模型，再接入一台能运行 Claude Code 或 Codex 的电脑。', hint: 'nav.agent', route: 'agent', action: '去配置' },
  { key: 'project', title: '添加要跟进的项目', desc: '给项目起个名字，写一句目标，Agent 会据此跟进。', hint: 'nav.projects', route: 'projects', action: '新建项目' },
  { key: 'memory', title: '告诉我一些背景', desc: '写下你的工作原则，或粘贴项目资料。', hint: 'nav.memory', route: 'memory', action: '添加记忆' },
  { key: 'channel', title: '连接飞书机器人', desc: '之后可以在飞书里和我对话，别人发你的消息也能变成待办。', hint: 'nav.channels', route: 'channels', action: '去连接', skippable: true },
];

export function createChatPage({ api, store, scope, router }) {
  const attention = createAttention({ api, store });
  const code = createCodeSidebar({ api, store });
  const recent = createRecentWork({ api, store, router, scope });
  const banner = h('div', { id: 'chat-banner' });
  const setup = h('div', { id: 'onboarding' });
  const runStrip = h('div', { id: 'run-strip', hidden: true });
  const messages = h('div', { class: 'msgs', id: 'messages', 'aria-live': 'polite' });
  const hero = h('div', { class: 'hero', hidden: true },
    h('h2', { class: 'hero__title' }, '今天想推进什么？'),
    h('p', { class: 'muted' }, '说出目标，Agent 会结合记忆安排下一步。'),
    h('div', { class: 'hero__chips' }));
  // 上半部分（标题、等你处理、引导）固定在顶部；只有消息流滚动，输入框固定在底部。
  const top = h('div', { class: 'chat__top' },
    h('div', { class: 'chat__inner chat__inner--top' },
      h('header', { class: 'page__head' },
        h('div', { class: 'page__title' }, h('h1', null, '对话'), h('p', { class: 'page__sub' }, hintCopy('nav.chat').tag)),
        h('div', { class: 'page__actions' }, code.toggle, Hint('nav.chat'))),
      banner, attention.el, setup, runStrip, recent.el));
  const scroller = h('div', { class: 'chat__scroll', id: 'chat-scroll' }, h('div', { class: 'chat__inner' }, messages, hero));

  // —— 输入框 ——
  const input = h('textarea', { class: 'composer__input', id: 'message-text', rows: 1, placeholder: '说出目标，Enter 发送，Shift + Enter 换行', 'aria-label': '给 Agent 的消息', maxLength: 20000 });
  const scopeSelect = h('select', { class: 'composer__scope', 'aria-label': '项目范围' }, h('option', { value: '' }, '全部项目'));
  const send = h('button', { class: 'btn btn--primary btn--sm composer__send', type: 'submit', 'aria-label': '发送' }, icon('send'), '发送');
  const status = h('p', { class: 'small composer__status', role: 'status' });
  const form = h('form', { class: 'composer', id: 'message-form' },
    h('div', { class: 'composer__box' }, input, h('div', { class: 'composer__bar' }, scopeSelect, h('span', { class: 'grow' }), send)), status);

  const el = h('section', { class: 'page page--chat', id: 'chat' }, h('div', { class: 'chat-code-main' }, top, scroller, form), code.el);

  let sending = false;
  let snapshot = null;
  let lastCount = 0;

  function autosize() { input.style.height = 'auto'; input.style.height = `${Math.min(input.scrollHeight, 200)}px`; }
  input.addEventListener('input', autosize);
  input.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) { event.preventDefault(); form.requestSubmit(); }
  });
  scopeSelect.addEventListener('change', () => scope.set(scopeSelect.value));
  scope.subscribe((value) => { scopeSelect.value = value; code.show(value); });

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const text = input.value.trim();
    if (!text || sending || !snapshot?.agent.available) return;
    sending = true; send.disabled = true; status.textContent = ''; status.className = 'small composer__status muted';
    try {
      await api.post('/messages', { text, ...(scope.get() ? { projectId: scope.get() } : {}) });
      if (input.value.trim() === text) { input.value = ''; autosize(); }
      scrollToEnd(true);
    } catch (error) {
      status.className = 'small composer__status text-danger';
      status.textContent = `发送没有成功：${error.message}。内容已保留，请核对后重试。`;
    } finally { sending = false; send.disabled = !snapshot?.agent.available; }
    store.refresh();
  });

  for (const text of EXAMPLES) {
    hero.querySelector('.hero__chips').append(h('button', { class: 'chip', type: 'button', onclick: () => { input.value = text; autosize(); input.focus(); } }, text));
  }

  function nearBottom() { return scroller.scrollHeight - scroller.clientHeight - scroller.scrollTop < 80; }
  function scrollToEnd(force = false) { if (force || nearBottom()) requestAnimationFrame(() => { scroller.scrollTop = scroller.scrollHeight; }); }

  function renderMessage(message) {
    const text = message.origin === 'notification' ? systemText(message.text) : message.text;
    if (message.origin === 'notification') {
      // 系统提醒只留一行摘要；完整内容（含原始数据）折叠在“详情”里。
      const [first, ...rest] = text.split('\n');
      return h('article', { class: 'msg msg--system', dataset: { id: message.id } },
        h('span', { class: 'msg__note' }, first, ' ', h('span', { class: 'msg__meta' }, timeAgo(message.createdAt))),
        rest.length > 0 && h('details', null, h('summary', null, '详情'), h('pre', null, rest.join('\n'))));
    }
    if (message.role === 'user') {
      return h('article', { class: 'msg msg--user', dataset: { id: message.id } },
        h('div', { class: 'msg__bubble' }, renderFormattedText(text)),
        h('span', { class: 'msg__meta' }, timeAgo(message.createdAt), message.status === 'failed' && ' · 发送失败'));
    }
    const label = message.origin === 'result' ? '执行结果' : message.origin === 'notification' ? '提醒' : '主 Agent';
    return h('article', { class: 'msg msg--assistant', dataset: { id: message.id } },
      h('span', { class: 'msg__avatar', 'aria-hidden': 'true' }, 'M'),
      h('div', { class: 'msg__col' },
        h('span', { class: 'msg__label' }, label),
        h('div', { class: 'msg__bubble' }, renderFormattedText(text)),
        h('span', { class: 'msg__meta' }, timeAgo(message.createdAt))));
  }

  function renderSetup(state) {
    const s = state.setup;
    const hasMessages = (state.messages ?? []).length > 0;
    const todo = s ? SETUP_STEPS.filter(step => step.key === 'channel' ? s.channel === 'todo' : !s[step.key]) : [];
    setup.hidden = !s || hasMessages || todo.length === 0;
    if (setup.hidden) return;
    const doneCount = SETUP_STEPS.length - todo.length;
    const rows = todo.map((step, index) => h('li', { class: `step ${index === 0 ? 'is-next' : ''}`, dataset: { step: step.key } },
      h('span', { class: 'step__mark', 'aria-hidden': 'true' }, String(SETUP_STEPS.findIndex(item => item.key === step.key) + 1)),
      h('div', { class: 'step__main' }, h('strong', null, step.title), h('span', { class: 'muted small' }, step.desc)),
      h('div', { class: 'step__end' },
        step.skippable && Button({ label: '先跳过', kind: 'ghost', size: 'sm', onClick: async () => { await api.post('/setup/channel-skip', {}); await store.refresh(); } }),
        h('a', { class: `btn btn--sm ${index === 0 ? 'btn--primary' : ''}`, href: router.href(step.route) }, step.action))));
    replace(setup, Card({
      title: '让 Agent 更了解你的工作', sub: `已完成 ${doneCount}/${SETUP_STEPS.length}，随时可以直接在下面说话`,
      body: h('ol', { class: 'steps' }, rows), className: 'setup',
    }));
  }

  function renderBanner(state) {
    const items = [];
    if (!state.agent.available) {
      items.push(Banner({ tone: 'warn', children: `主 Agent 暂不可用：${state.agent.reason || '尚未配置模型'}`, action: h('a', { class: 'btn btn--sm', href: router.href('agent') }, '去配置') }));
    } else if (state.mode === 'demo' && sessionStorage.getItem('sm.demo-dismissed') !== '1') {
      const notice = Banner({ children: '演示模式：回复是固定内容，不调用真实模型，也不会运行真实执行者。' });
      notice.append(Button({ label: '知道了', kind: 'ghost', size: 'sm', onClick: () => { sessionStorage.setItem('sm.demo-dismissed', '1'); notice.remove(); } }));
      items.push(notice);
    }
    replace(banner, items);
  }

  function renderRuns(state) {
    const active = (state.runs ?? []).filter(run => run.status === 'queued' || run.status === 'running');
    runStrip.hidden = active.length === 0;
    if (!active.length) return;
    replace(runStrip, h('a', { class: 'strip', href: router.href('projects', 'all', 'runs') },
      h('span', { class: 'spinner', 'aria-hidden': 'true' }), `Agent 正在执行 ${active.length} 项任务`, h('span', { class: 'muted' }, '查看进展 ›')));
  }

  return {
    el,
    onShow() { recent.refresh(); requestAnimationFrame(() => { scrollToEnd(true); }); },
    focus() { input.focus(); },
    onState({ snapshot: state, attention: items }) {
      snapshot = state;
      code.show(scope.get());
      attention.update(items);
      renderBanner(state); renderSetup(state); renderRuns(state);
      recent.update(state);
      const list = state.messages ?? [];
      const follow = nearBottom();
      keyedList(messages, list, item => item.id, renderMessage, item => `${item.id}:${item.status}:${item.text}`);
      hero.hidden = list.length > 0 || !setup.hidden;
      if (list.length !== lastCount) { lastCount = list.length; if (follow) scrollToEnd(true); }
      send.disabled = sending || !state.agent.available;
      input.placeholder = state.agent.available ? '说出目标，Enter 发送，Shift + Enter 换行' : '主 Agent 暂不可用，请先完成模型配置';
      const projects = (state.projects ?? []).filter(item => !item.archivedAt);
      const signature = JSON.stringify(projects.map(item => [item.id, item.name]));
      if (scopeSelect.dataset.sig !== signature) {
        scopeSelect.dataset.sig = signature;
        replace(scopeSelect, h('option', { value: '' }, '全部项目'), projects.map(item => h('option', { value: item.id }, item.name)));
      }
      scopeSelect.value = scope.get();
    },
  };
}
