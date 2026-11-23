import { h, replace } from '../lib/dom.js';
import { Button, Field, Input, TextArea } from '../ui/kit.js';

const labels = { web: '主人在 Web 修改', assistant: '助手修改' };

export function createRunScope({ api, runId, projectId, valid, canEdit, saved }) {
  const path = '/runs/' + encodeURIComponent(runId) + '/scope';
  const url = path + '?' + new URLSearchParams({expectedProjectId:projectId ?? ''});
  const history = h('div', {class:'stack'});
  const notice = h('p', {role:'status',class:'small'});
  const criterion = TextArea({rows:2});
  const reason = TextArea({rows:2});
  const minutes = Input({type:'number',min:'0',max:'10080',step:'any',placeholder:'沿用原预计时间'});
  const check = Button({label:'核对当前版本',size:'sm',onClick:() => load()});
  const adopt = Button({label:'按最新版本继续编辑',size:'sm',onClick:() => {
    if (!active() || !latest || !verified) return;
    base = latest; remember(); notice.textContent = '已采用最新版本，草稿仍可修改。'; sync();
  }});
  const submit = Button({label:'保存验收标准',size:'sm',kind:'primary',onClick:write});
  const form = h('fieldset', {class:'stack',hidden:true}, h('legend',null,'修改验收标准'),
    Field({label:'新的验收标准',control:criterion}), Field({label:'变更理由',control:reason}),
    Field({label:'新的预计分钟（可选）',control:minutes}), h('div',{class:'row'},adopt,submit));
  const panel = h('details', {class:'small','aria-label':'验收标准变更'},h('summary',{'aria-label':'验收标准变更 · ' + runId},'验收标准变更'),history,form,notice,check);
  let latest, base, uncertain, dirty = false, writing = false, verified = false, read = 0;
  // Keep an unfinished edit through a reload in this tab, scoped to the credential owner and the execution.
  const draftKey = 'sm.run-scope.' + JSON.stringify([api.draftOwner(),projectId ?? null,runId]);
  function remember() {
    try {
      if (!dirty) { sessionStorage.removeItem(draftKey); return; }
      sessionStorage.setItem(draftKey, JSON.stringify({version:base.version, before:base.doneWhen, previousMinutes:base.expectMinutes,
        criterion:criterion.value, reason:reason.value, minutes:minutes.value, uncertain}));
    } catch { /* Continue with the in-page draft if browser storage is unavailable. */ }
  }
  try {
    const draft = JSON.parse(sessionStorage.getItem(draftKey));
    if (draft && Number.isSafeInteger(draft.version) && draft.version >= 0 &&
      [draft.before,draft.criterion,draft.reason,draft.minutes].every(value => typeof value === 'string')) {
      dirty = true; base = {version:draft.version, doneWhen:draft.before, expectMinutes:draft.previousMinutes};
      criterion.value = draft.criterion; reason.value = draft.reason; minutes.value = draft.minutes; uncertain = draft.uncertain;
    }
  } catch { /* A missing or unreadable draft leaves the form empty. */ }
  function active() { return valid() && panel.open && panel.isConnected && panel.closest('dialog')?.open !== false; }
  function sync() {
    const editable = latest?.status === 'running' && canEdit();
    const conflict = dirty && latest && base && latest.version !== base.version;
    form.hidden = !latest || (!editable && !dirty);
    form.disabled = !editable || writing || !verified;
    adopt.hidden = !editable || !conflict;
    check.disabled = writing;
    submit.disabled = !dirty || !editable || !verified || writing || conflict || !criterion.value.trim() ||
      (criterion.value.trim() === base?.doneWhen && (minutes.value === '' || minutes.valueAsNumber === base?.expectMinutes)) || !reason.value.trim() ||
      (minutes.value !== '' && (!Number.isFinite(minutes.valueAsNumber) || minutes.valueAsNumber <= 0 || minutes.valueAsNumber > 10080)) || minutes.validity.badInput;
  }
  for (const input of [criterion,reason,minutes]) input.addEventListener('input',() => { dirty = true; remember(); sync(); });

  function show(state) {
    if (state?.runId !== runId || (state.projectId ?? null) !== (projectId ?? null) ||
      !Number.isSafeInteger(state.version) || !Array.isArray(state.history)) throw new Error('执行归属或回执版本无法核对。');
    latest = state; verified = true;
    if (uncertain) {
      const event = state.history.find(entry => entry.version === uncertain.expectedVersion + 1);
      const matched = event?.source?.kind === 'web' && event.before === uncertain.expectedDoneWhen &&
        event.after === uncertain.doneWhen && event.reason === uncertain.reason &&
        event.expectMinutes === (uncertain.expectMinutes ?? base.expectMinutes);
      uncertain = undefined;
      if (matched) { dirty = false; notice.textContent = '已核对变更记录，验收标准已保存。'; }
    }
    const dropped = state.droppedCriteria;
    replace(history, h('p',null,'当前标准 · ' + state.doneWhen),
      Array.isArray(dropped) && dropped.length > 0 && h('section', {class:'stack','aria-label':'已移出当前验收范围的标准'},
        h('h4',null,'已移出当前验收范围的标准'),
        h('ul',{class:'stack'},dropped.map(item => h('li',null,
          h('strong',null,item.criterion),h('div',null,'移除原因 · ' + item.reason),
          h('span',{class:'muted'},'版本 ' + item.version + ' · ' + new Date(item.createdAt).toLocaleString('zh-CN')))))),
      state.history.length ? h('ol',{class:'stack'},state.history.map(entry => h('li',null,
        h('div',null,'原标准 · ' + entry.before),h('div',null,'新标准 · ' + entry.after),h('div',null,'变更理由 · ' + entry.reason),
        !!entry.added?.length && h('div',null,'新增条目',h('ul',null,entry.added.map(text => h('li',null,text)))),
        !!entry.dropped?.length && h('div',null,'移除条目',h('ul',null,entry.dropped.map(text => h('li',null,text)))),
        entry.expectMinutes !== entry.previousExpectMinutes && h('div',null,'预计时长 · ' +
          (entry.previousExpectMinutes == null ? '未设置' : entry.previousExpectMinutes + ' 分钟') + ' → ' + entry.expectMinutes + ' 分钟'),
        h('span',{class:'muted'},[labels[entry.source?.kind] || '来源未标明',new Date(entry.createdAt).toLocaleString('zh-CN')].join(' · '))))) :
        h('p',{class:'muted'},'尚无验收标准变更。'));
    if (!dirty) { base = state; criterion.value = state.doneWhen; reason.value = ''; minutes.value = ''; }
    remember();
    if (state.status !== 'running') notice.textContent = '仅运行中的执行可以修改验收标准。';
    else if (!canEdit()) notice.textContent = '待办已完成或项目已归档，当前仅可查看历史。';
    else if (dirty && base.version !== state.version) notice.textContent = '标准已变化。请核对当前标准，草稿已保留。';
    sync();
  }
  async function load() {
    if (!active() || writing) return;
    const stamp = ++read;
    verified = false; sync();
    notice.textContent = '正在读取验收标准…';
    try {
      const state = await api.get(url);
      if (!active() || stamp !== read) return;
      notice.textContent = ''; show(state);
    } catch (error) {
      if (active() && stamp === read) { replace(history); notice.textContent = error.message; sync(); }
    }
  }
  async function write() {
    if (!active() || !canEdit() || submit.disabled || writing) return;
    writing = true; ++read; sync();
    const body = {expectedProjectId:projectId ?? null,expectedVersion:base.version,expectedDoneWhen:base.doneWhen,
      doneWhen:criterion.value.trim(),reason:reason.value.trim(),...(minutes.value !== '' && {expectMinutes:minutes.valueAsNumber})};
    try {
      uncertain = body; remember();
      const state = await api.post(path,body);
      if (!valid()) return;
      if (state?.runId !== runId || state.doneWhen !== body.doneWhen || state.version !== body.expectedVersion+1 ||
        (state.projectId ?? null) !== (projectId ?? null) || !Array.isArray(state.history)) throw new Error('未收到匹配的保存回执。');
      uncertain = undefined; dirty = false; show(state); notice.textContent = '验收标准已保存。';
      saved();
    } catch (error) {
      if (!valid()) return;
      verified = false;
      if (error.status >= 400 && error.status < 500) uncertain = undefined;
      remember();
      notice.textContent = error.status === 409 ? '标准已变化，请核对当前版本。草稿已保留。' :
        error.status >= 400 && error.status < 500 ? error.message : '未收到保存确认，请核对当前版本。草稿已保留。';
    } finally { writing = false; sync(); }
  }
  panel.addEventListener('toggle',() => { ++read; if (panel.open) void load(); });
  sync();
  return {panel,refresh:load};
}
