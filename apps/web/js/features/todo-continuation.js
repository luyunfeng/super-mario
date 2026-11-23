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
