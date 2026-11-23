// “等你处理”：审批、提问、飞书消息待办共用一种卡片，一次点击处理。
// 提交结果有三种：已接收、未送达（可重试）、结果未知（不自动重试，先核对）。
import { h, keyedList } from '../lib/dom.js';
import { timeAgo } from '../lib/format.js';
import { Button, Pill, Field, Input, TextArea, Banner } from '../ui/kit.js';
import { confirmDialog, openDrawer } from '../ui/overlay.js';
import { createQuestionAnswers } from './question-answers.js';
import { openInboxHandlingDrawer } from './inbox-handling.js';

const TYPES = {
  approval: { text: '审批', tone: 'warn' },
  interaction: { text: '提问', tone: 'info' },
  plan: { text: '计划', tone: 'info' },
  inbox: { text: '消息', tone: '' },
};

export function createAttention({ api, store, task = false }) {
  const list = h('div', { class: 'attn__list' });
  const more = h('button', { class: 'btn btn--ghost btn--sm', type: 'button' });
  const foldBtn = h('button', { class: 'btn btn--ghost btn--sm', type: 'button' }, '最小化');
  const nextBtn = h('button', { class: 'btn btn--ghost btn--sm', type: 'button' }, '下一件');
  const title = h('h2', { id: task ? undefined : 'attention-title' }, task ? '本事项等你处理' : '等你处理');
  const count = h('span', { class: 'pill pill--danger', id: task ? undefined : 'attention-count' });
  const root = h('section', { class: 'attn card', id: task ? undefined : 'attention', 'aria-labelledby': task ? undefined : 'attention-title', 'aria-label': task ? '本事项等你处理' : undefined, 'aria-live': 'polite', hidden: true },
    h('header', { class: 'attn__head' }, title, count, h('span', { class: 'grow' }), nextBtn, more, foldBtn),
    list);
  let expanded = false;
  let minimized = false;
  let items = [];
  let currentId;
  // Keep each unchanged card's DOM while paging; an unfinished answer is a draft.
  const cards = new Map();
  // 一屏放不下很多卡片：窄屏默认只显示 1 条，桌面 2 条，其余收在“还有 N 件”里。
  const limit = () => (matchMedia('(max-width: 767px)').matches ? 1 : 2);

  // 审批可以先改再批：修改会产生新版本，批准的永远是你看到的最新版本。
  const PARAM_LABELS = { prompt: '执行内容', text: '发送内容', command: '执行命令', cwd: '工作目录', doneWhen: '完成标准' };
  function openEdit(item) {
    const id = item.id.replace(/^approval:/, '');
    const approval = (store.view.snapshot?.approvals ?? []).find(entry => entry.id === id);
    if (!approval) return;
    if(approval.kind==='plugin:inbox-triage.handle-suggestion'){
      const source=approval.params?.source;
      if(source&&['personal','mailbox'].includes(source.kind)&&typeof source.id==='string')openInboxHandlingDrawer({api,store,source:{kind:source.kind,id:source.id}});
      return;
    }
    const title = Input({ value: approval.title, required: true });
    const details = TextArea({ value: approval.details ?? '', rows: 3 });
    const keys = Object.keys(PARAM_LABELS).filter(key => typeof approval.params?.[key] === 'string');
    const params = Object.fromEntries(keys.map(key => [key, key === 'cwd' || key === 'doneWhen' ? Input({ value: approval.params[key] }) : TextArea({ value: approval.params[key], rows: 3 })]));
    const message = h('div', { role: 'alert' });
    const drawer = openDrawer({
      title: '修改后再批准', subtitle: '保存后会生成新版本，需要再点一次“批准”。',
      body: [Field({ label: '标题', control: title, required: true }), Field({ label: '说明', control: details }),
        ...keys.map(key => Field({ label: PARAM_LABELS[key], control: params[key] })), message],
      footer: [Button({ label: '取消', onClick: () => drawer.close() }), Button({
        label: '保存修改', kind: 'primary',
        onClick: async () => {
          try {
            await api.patch(`/approvals/${encodeURIComponent(id)}`, { version: approval.version, title: title.value.trim(), details: details.value,
              params: { ...approval.params, ...Object.fromEntries(keys.map(key => [key, params[key].value.trim()])) } });
          } catch (error) {
            message.replaceChildren(Banner({ tone: 'danger', children: error.status === 409 ? '这条审批刚刚被改动或处理过，已为你重新载入，请关闭后重新核对。' : `保存没有成功：${error.message}。内容已保留。` }));
            store.refresh();
            return;
          }
          drawer.close(); store.refresh();
        },
      })],
    });
  }

  function resultNote(result, action) {
    if (result?.status === 'answered') {
      if (result.delivery === 'failed') return { text: '回答已记录，后续处理失败。', tone: 'danger' };
      if (result.delivery !== 'confirmed') return { text: '回答已记录，后续处理结果未知。请核对回执。', tone: 'danger' };
      return { text: '回答已记录。' };
    }
    if (result?.status === 'unknown' || result?.delivery === 'unknown') return { text: '结果未知，请先核对，不要重复提交。', tone: 'danger' };
    if (result?.status === 'failed' || result?.delivery === 'failed') return { text: '操作没有执行，内容已保留，可以重试。', tone: 'danger', retry: true };
    if (result?.status === 'withdrawn') return { text: '提问已关闭。' };
    if (action.path.endsWith('/reject')) return { text: '已拒绝' };
    if (action.path.endsWith('/archive')) return { text: '已忽略' };
    return { text: '已接收，等待结果' };
  }

  function createCard(item) {
    const type = TYPES[item.type] ?? { text: '待处理', tone: '' };
    const note = h('p', { class: 'small', role: 'status' });
    const actions = h('div', { class: 'attn__actions' });
    const textAction = item.actions.find(action => action.requiresText);
    const questions = textAction && item.questions?.length ? createQuestionAnswers(item.questions) : null;
    const input = textAction && !questions ? h('input', { class: 'input', placeholder: '输入你的回答，回车发送', 'aria-label': `回答：${item.title}`, autocomplete: 'off' }) : null;
    let done = false, submitting = false;

    async function submit(action) {
      if (done || submitting) return;
      const text = input?.value.trim() ?? '';
      const answers = action.requiresText && questions?.answers();
      if (action.requiresText && questions && !answers) { note.textContent = '请回答每一道题。'; return; }
      if (action.requiresText && !questions && !text) { note.textContent = '请先写下回答'; input.focus(); return; }
      if (action.highRisk) {
        const ok = await confirmDialog({
          title: `${action.label}这项高风险操作？`,
          message: h('div', { class: 'stack' }, h('p', null, item.title), h('p', { class: 'muted' }, '确认后会在当前权限内直接执行，可能修改或删除文件。请先展开“详情”核对。')),
          confirmLabel: `确认${action.label}`, danger: true,
        });
        if (!ok) return;
      }
      if (done || submitting) return;
      submitting = true; questions?.disable(true);
      try {
        const result = await api(action.path, { method: action.method, body: { ...action.body, ...(answers ? { answers } : action.requiresText ? { text } : {}) } });
        const outcome = resultNote(result, action);
        note.textContent = outcome.text;
        note.className = `small ${outcome.tone === 'danger' ? 'text-danger' : 'muted'}`;
        if (!outcome.retry) { done = true; actions.hidden = true; if (input) input.disabled = true; }
      } catch (error) {
        // 已被其他设备处理（409）不是错误：刷新后卡片会消失。
        note.textContent = error.status === 409 ? '已在另一处处理，列表即将更新。' : `提交没有成功：${error.message}。内容已保留。`;
        note.className = `small ${error.status === 409 ? 'muted' : 'text-danger'}`;
      }
      submitting = false;
      if (!done) questions?.disable(false);
      store.refresh();
    }

    // 需要文字的动作（回答）放在输入框旁；其余动作是按钮，第一个为主操作。
    for (const [index, action] of item.actions.filter(entry => !entry.requiresText).entries()) {
      actions.append(Button({ label: action.label, kind: item.wait === false ? 'ghost' : index === 0 ? 'primary' : 'secondary', size: 'sm', onClick: () => submit(action), dataset: { action: action.label } }));
    }
    if (item.type === 'approval' && item.editable !== false && item.id.startsWith('approval:')) actions.append(Button({ label: '改一下', kind: 'ghost', size: 'sm', onClick: () => openEdit(item), dataset: { action: '改一下' } }));
    input?.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) { event.preventDefault(); submit(textAction); }
    });

    const detail = item.detail && h('details', { class: 'attn__detail' }, h('summary', null, '详情'), h('pre', null, item.detail));
    const context = [item.context, item.projectName && `项目：${item.projectName}`, item.source && `来自：${item.source}`].filter(Boolean).join(' · ');
    return h('article', { class: `attn__card ${item.highRisk ? 'is-risk' : ''}`, tabindex: -1, dataset: { type: item.type, id: item.id } },
      h('header', { class: 'attn__top' },
        Pill(type.text, type.tone), item.highRisk && Pill('高风险', 'danger'),
        h('h3', { class: 'attn__title' }, item.title), h('span', { class: 'attn__time muted small' }, timeAgo(item.createdAt))),
      h('p', { class: 'muted small' }, context),
      detail,
      questions?.el,
      textAction && h('div', { class: 'attn__reply' }, input, Button({ label: textAction.label, kind: 'primary', size: 'sm', onClick: () => submit(textAction), dataset: { action: textAction.label } })),
      actions.children.length > 0 && actions, note,
      item.route && !(task && item.type === 'interaction') && h('a', { class: 'small', href: item.route.href }, item.route.label));
  }

  function renderCard(item) {
    const signature = JSON.stringify(item), previous = cards.get(item.id);
    if (previous?.signature === signature) return previous.node;
    const node = createCard(item);
    cards.set(item.id, { signature, node });
    return node;
  }

  more.addEventListener('click', () => { expanded = !expanded; paint(); });
  foldBtn.addEventListener('click', () => { minimized = !minimized; paint(); });
  nextBtn.addEventListener('click', () => {
    if (!items.length) return;
    currentId = items[(items.findIndex(item => item.id === currentId) + 1) % items.length].id;
    minimized = false;
    paint();
    const target = [...list.children].find(node => node.dataset.id === currentId);
    target?.focus({ preventScroll: true });
    target?.scrollIntoView({ block: 'nearest', behavior: 'instant' });
  });

  function paint() {
    root.hidden = items.length === 0;
    count.textContent = String(items.length);
    root.classList.toggle('is-minimized', minimized);
    list.hidden = minimized;
    foldBtn.textContent = minimized ? '展开处理' : '最小化';
    foldBtn.setAttribute('aria-expanded', String(!minimized));
    const selected = Math.max(0, items.findIndex(item => item.id === currentId));
    const offset = Math.floor(selected / limit()) * limit();
    const visible = expanded ? items : items.slice(offset, offset + limit());
    keyedList(list, visible, item => item.id, renderCard);
    more.hidden = minimized || items.length <= limit();
    more.textContent = expanded ? '收起' : `还有 ${items.length - limit()} 件`;
    nextBtn.setAttribute('aria-label', `下一件待处理，共 ${items.length} 件`);
  }

  return {
    el: root,
    update(next) {
      items = next;
      const ids = new Set(items.map(item => item.id));
      for (const id of cards.keys()) if (!ids.has(id)) cards.delete(id);
      paint();
    },
    reveal(id) {
      if (!items.some(item => item.id === id)) return false;
      currentId = id;
      minimized = false;
      paint();
      const card = cards.get(id)?.node;
      card?.focus();
      card?.scrollIntoView({ block: 'nearest' });
      return true;
    },
    expand() { expanded = true; minimized = false; paint(); },
  };
}
