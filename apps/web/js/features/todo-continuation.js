import { h } from '../lib/dom.js';
import { uuid } from '../lib/format.js';
import { Button, Field, Input, TextArea } from '../ui/kit.js';
import { openDrawer } from '../ui/overlay.js';

const outstanding = new Map();

export function openTodoContinuation({ api, store, router, todo }) {
  const owner = api.draftOwner(), project = todo.projectId ?? null;
  const key = 'sm.todo-continuation.' + JSON.stringify([owner, project, todo.id]);
  function inScope() {
    return owner === api.draftOwner() && owner === store.view.snapshotOwner && !store.view.unauthorized &&
      store.view.snapshot?.todos?.some(item => item.id === todo.id && (item.projectId ?? null) === project) &&
      (!project || store.view.snapshot.projects?.some(item => item.id === project && !item.archivedAt));
  }
  if (!inScope()) return;
  let pending = outstanding.get(key);
  if (!pending) {
    try {
      const saved = JSON.parse(sessionStorage.getItem(key));
      if (saved?.expectedProjectId === project && typeof saved.title === 'string' &&
        typeof saved.continuationReason === 'string' && typeof saved.requestId === 'string' && /^[\da-f-]{1,128}$/i.test(saved.requestId))
        pending = saved;
    } catch { /* The in-page copy is available if session storage is restricted. */ }
  }
  function remember(body) {
    pending = body;
    if (body) outstanding.set(key, body); else outstanding.delete(key);
    try { if (body) sessionStorage.setItem(key, JSON.stringify(body)); else sessionStorage.removeItem(key); } catch {}
  }
  const title = Input({value:pending?.title || ''});
  const reason = TextArea({rows:4,value:pending?.continuationReason || ''});
  const retry = '创建结果尚未确认。可用原请求重试，核对这一次创建的续办。';
  const note = h('p',{class:'small',role:'status'},pending ? retry : '');
  let busy = false;
  function sync() {
    title.readOnly = reason.readOnly = !!pending;
    submit.disabled = busy || !title.value.trim() || !reason.value.trim();
    submit.textContent = pending ? '用原请求重试' : '确认创建续办';
  }
  const submit = Button({label:'确认创建续办',kind:'primary',onClick:async () => {
    if (busy || !inScope()) return;
    const name = title.value.trim(), explanation = reason.value.trim();
    if (!name || !explanation || Array.from(name).length > 500 || Array.from(explanation).length > 4000) {
      note.textContent = '请填写标题和交接说明。标题最多 500 个字符，交接说明最多 4000 个字符。'; return;
    }
    if (!pending) remember({title:name,continuationReason:explanation,expectedProjectId:project,requestId:uuid()});
    busy = true; sync(); note.textContent = '正在创建续办…';
    const active = () => drawer.el.open && inScope();
    try {
      const result = await api.post('/todos/'+encodeURIComponent(todo.id)+'/continue', pending);
      if (!active()) return;
      if (!result?.id || result.continuesTodoId !== todo.id || (result.projectId ?? null) !== project)
        throw new Error('未收到匹配的续办记录');
      await store.refresh();
      if (!active()) return;
      remember(null);
      drawer.close();
      router.go(router.href('projects',project ?? 'all','todos','detail',result.id));
    } catch (error) {
      if (!active()) return;
      if ([400,401,403,404,409,422].includes(error.status)) { remember(null); note.textContent = error.message; }
      else note.textContent = retry;
    } finally { busy = false; if (active()) sync(); }
  }});
  title.addEventListener('input',sync); reason.addEventListener('input',sync);
  const drawer = openDrawer({title:'创建续办',subtitle:todo.title,body:[
    Field({label:'续办标题',control:title}),Field({label:'交接说明',control:reason}),note],
    footer:submit,onClose:() => unsubscribe()});
  const unsubscribe = store.subscribe(() => { if (!inScope()) drawer.close(); });
  sync();
}

export function createTodoLineage({ api, store, router, todo, close }) {
  const owner = api.draftOwner();
  const body = h('div', { class: 'stack small', 'aria-live': 'polite' });
  const panel = h('details', { hidden: true, 'aria-label': '续办历程' }, h('summary', null, '续办历程'), body);
  let signature, sequence = 0, visible = new Set();
  function sameOwner() {
    return owner === api.draftOwner() && owner === store.view.snapshotOwner && !store.view.unauthorized;
  }

  async function load() {
    const stamp = ++sequence;
    const active = () => stamp === sequence && panel.isConnected && panel.open && !panel.hidden &&
      panel.closest('dialog')?.open !== false && sameOwner();
    if (!active()) return;
    body.textContent = '正在读取续办历程…';
    try {
      const query = new URLSearchParams({ expectedProjectId: todo.projectId ?? '' });
      const { steps } = await api.get('/todos/' + encodeURIComponent(todo.id) + '/lineage?' + query);
      if (!active()) return;
      if (steps.length < 2) { panel.hidden = true; panel.open = false; body.replaceChildren(); return; }
      const current = steps.filter(step => step.current);
      if (current.length !== 1 || current[0].id !== todo.id || steps.some(step => !visible.has(step.id))) {
        throw new Error('待办范围已变化，请重新读取。');
      }
      const titles = new Map(steps.map(step => [step.id, step.title]));
      const rows = steps.map(step => {
        const session = step.responsibleSession;
        const link = step.current ? h('strong', { 'aria-current': 'step' }, step.title + '（正在查看）') :
          h('a', { href: router.href('projects', todo.projectId ?? 'all', 'todos', 'detail', step.id), onclick: () => close?.() }, step.title);
        return h('li', { class: 'stack' }, link,
          step.continuesTodoId && h('span', null, '直接前序 · ' + (titles.get(step.continuesTodoId) || '无法核对')),
          h('span', { class: 'muted' }, '创建于 ' + new Date(step.createdAt).toLocaleString('zh-CN'),
            step.completedAt && ' · 完成于 ' + new Date(step.completedAt).toLocaleString('zh-CN')),
          step.continuationReason && h('span', { style: { whiteSpace: 'pre-wrap' } }, '交接说明 · ' + step.continuationReason),
          session && h('span', null, '负责会话 · ' + session.machineId + ' / ' + session.sessionId));
      });
      body.replaceChildren(h('ol', { class: 'stack' }, rows));
    } catch (error) {
      if (active()) body.replaceChildren(h('p', null, error.message), Button({ label: '重新读取历程', size: 'sm', onClick: load }));
    }
  }
  panel.addEventListener('toggle', () => {
    if (panel.open) void load();
    else { ++sequence; body.replaceChildren(); }
  });
  function update(family) {
    if (!sameOwner() || family.length < 2) {
      ++sequence; signature = undefined; visible.clear(); panel.hidden = true; panel.open = false; body.replaceChildren(); return;
    }
    const next = JSON.stringify(family.map(step => [step.id, step.title, step.continuesTodoId, step.createdAt,
      step.completedAt, step.continuationReason, step.responsibleSession]));
    if (next === signature) return;
    signature = next;
    visible = new Set(family.map(step => step.id));
    panel.hidden = false;
    if (panel.open) void load();
  }
  return { panel, update };
}
