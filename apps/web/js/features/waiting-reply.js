import { h, replace } from '../lib/dom.js';
import { Button, Card, Field, Input, Select } from '../ui/kit.js';
import { openDrawer } from '../ui/overlay.js';

// Drafts stay in memory, partitioned by API client and credential. Never persist identities.
const draftsByApi = new WeakMap();
let active;
const identity = item => JSON.stringify([item.senderIdType, item.senderId]);
const short = value => value.length > 28 ? `${value.slice(0, 12)}…${value.slice(-10)}` : value;
const time = value => value ? new Date(value).toLocaleString('zh-CN') : '时间未知';
const wrap = { minWidth: '0', maxWidth: '100%', overflowWrap: 'anywhere', whiteSpace: 'pre-wrap' };

export function refreshWaitingReply(api) {
  if (active?.api === api) active.refresh();
}

export function openWaitingReply({ api, store, todo }) {
  active?.close();
  const token = api.token?.();
  let credentials = draftsByApi.get(api);
  if (!credentials) { credentials = new Map(); draftsByApi.set(api, credentials); }
  let drafts = credentials.get(token);
  if (!drafts) { drafts = new Map(); credentials.set(token, drafts); }
  let draft = drafts.get(todo.id);
  if (!draft) { draft = { anchorId: '', person: '', key: '', pending: false, needsCheck: false }; drafts.set(todo.id, draft); }
  let alive = true, sequence = 0, loaded = false, reading = false, sources = [], identitySources = [], snapshot = null;
  const base = `/todos/${encodeURIComponent(todo.id)}/waiting-reply`;
  const current = () => alive && drawer.el.open && api.token?.() === token;
  const state = h('div', { class: 'stack small', 'aria-live': 'polite', style: wrap }, '正在读取…');
  const notice = h('p', { class: 'small text-danger', role: 'alert', style: wrap });
  const query = Input({ type: 'search', placeholder: '按内容、联系人或消息标识查找', 'aria-label': '查找跟进消息', maxLength: 200 });
  const search = Button({ label: '查找消息', size: 'sm', onClick: () => read(true) });
  query.addEventListener('keydown', event => { if (event.key === 'Enter') { event.preventDefault(); read(true); } });
  const sourceHint = h('p', { class: 'small muted', style: wrap });
  const preview = h('div', { class: 'small', style: wrap });
  const personHint = h('div', { class: 'small muted', style: wrap });
  const anchor = Select({ options: [], style: { minWidth: '0', width: '100%' } });
  const person = Select({ options: [], style: { minWidth: '0', width: '100%' } });
  const selected = () => sources.find(item => item.id === draft.anchorId);
  const people = () => {
    const message = selected();
    return [...new Map(identitySources.filter(item => message && item.source === message.source && item.chatId === message.chatId)
      .map(item => [identity(item), item])).values()];
  };
  function sync() {
    const locked = !loaded || draft.pending || draft.needsCheck;
    anchor.disabled = locked; person.disabled = locked || !selected();
    save.disabled = locked || !selected() || !people().some(item => identity(item) === draft.person);
    check.disabled = draft.pending; search.disabled = draft.pending || reading;
  }
  function paintPeople() {
    replace(person, h('option', { value: '' }, '选择等待对象'), people().map(item => h('option', { value: identity(item) }, `${item.label || '身份'} · ${item.senderIdType} ${short(item.senderId)}`)));
    person.value = draft.person;
    const message = selected(), who = people().find(item => identity(item) === draft.person);
    replace(preview, message ? [h('p', null, message.preview || '无正文预览'), h('p', { class: 'muted' }, time(message.createdAt)), h('details', null, h('summary', null, '查看消息标识'), h('p', null, `来源：${message.source}\n会话：${message.chatId}\n消息：${message.messageId}`))] : []);
    replace(personHint, who ? [h('p', null, '按此人在该会话中的真实身份匹配，显示名只帮助选择。'), h('details', null, h('summary', null, '查看等待人标识'), h('p', null, `身份类型：${who.senderIdType}\n身份标识：${who.senderId}`))] : '仅列出同来源、同会话已出现的身份。');
    sync();
  }
  function paintState() {
    const descriptions = { waiting: '等待匹配：目前尚未查到符合条件的直接回复证据，不能据此断定对方未回复。', matched: '已命中直接回复，本轮提醒已停止；待办仍需手动确认完成。', superseded: '本轮已被后续等待替代。', invalidated: '本轮已失效，请核对待办和来源。' };
    replace(state, snapshot ? [h('p', null, `${{ waiting: '等待回复', matched: '已收到回复', superseded: '已被新等待替代', invalidated: '等待已失效' }[snapshot.status] || '状态未知'} · 第 ${snapshot.cycle} 轮\n${descriptions[snapshot.status] || '状态未知'}`),
      h('p', null, `开始：${time(snapshot.startedAt)}${snapshot.endedAt ? `\n结束：${time(snapshot.endedAt)}` : ''}`),
      snapshot.hit && h('p', null, `实际命中时间：${time(snapshot.hit.evidence.createdAt)}\n命中消息 ID：${snapshot.hit.evidence.messageId}\n处理时间：${time(snapshot.hit.processedAt)}`),
      h('details', null, h('summary', null, '查看来源证据'),
        h('p', null, `原消息：${snapshot.anchor.messageId}\n来源：${snapshot.anchor.source}\n会话：${snapshot.anchor.chatId}\n等待身份：${snapshot.expectedSenderIdType} / ${snapshot.expectedSenderId}`),
        snapshot.hit && h('p', null, `回复来源：${snapshot.hit.evidence.source}\n回复会话：${snapshot.hit.evidence.chatId}\n回复人：${snapshot.hit.evidence.senderIdType} / ${snapshot.hit.evidence.senderId}\n直接回复：${snapshot.hit.evidence.parentId || '未提供'}\n依据：${snapshot.hit.reason}`))] : '尚未设置回复跟踪；这不代表对方没有回复。');
  }
  async function read(full = false) {
    if (!current() || draft.pending || reading) return;
    reading = true;
    const stamp = ++sequence;
    try {
      const [value, result] = await Promise.all([api.get(base), full ? api.get(`${base}/sources${query.value.trim() ? `?query=${encodeURIComponent(query.value.trim())}` : ''}`) : Promise.resolve(null)]);
      if (!current() || stamp !== sequence) return;
      snapshot = value; paintState();
      if (full) {
        sources = result.items; identitySources = Array.isArray(result.people) ? result.people : sources; loaded = true;
        // Only an explicit read/open reconciles an uncertain write. Keep its key unless confirmed.
        if (snapshot && snapshot.key === draft.key) { draft.key = ''; draft.anchorId = ''; draft.person = ''; }
        draft.needsCheck = false;
        replace(anchor, h('option', { value: '' }, '选择要跟进的原消息'), sources.map(item => h('option', { value: item.id }, `${time(item.createdAt)} · ${(item.preview || item.messageId).slice(0, 64)}`)));
        anchor.value = draft.anchorId;
        sourceHint.textContent = !sources.length ? query.value.trim() ? '没有匹配的消息，请更换关键词；采集设置保持原样。' : '没有可选消息。请在来源设置中明确开启只读采集，并等待已验证来源的真实消息；此处不会自动授权或采集。'
          : result.truncated ? `来源列表已截断：仅显示 ${sources.length} / ${result.total} 条（上限 ${result.limit}）。` : `已采集 ${result.total} 条来源消息。`;
        if (result.peopleTruncated) sourceHint.textContent += ' 联系人列表也已截断。';
        notice.textContent = draft.anchorId && !selected() ? '草稿消息已不在可选列表中，请核对后重新选择。' : '';
        paintPeople();
      }
    } catch (error) {
      if (current() && stamp === sequence) notice.textContent = `读取失败：${error.message}。请先核对，不要盲目重试提交。`;
    } finally { reading = false; if (current() && stamp === sequence) sync(); }
  }
  const check = Button({ label: '核对当前状态', onClick: () => read(true) });
  const save = Button({ label: '跟踪所选回复', kind: 'primary', onClick: async () => {
    if (!current() || save.disabled || draft.pending || draft.needsCheck) return;
    const who = people().find(item => identity(item) === draft.person);
    draft.key ||= crypto.randomUUID();
    const body = { key: draft.key, anchorId: draft.anchorId, expectedSenderId: who.senderId, expectedSenderIdType: who.senderIdType };
    draft.pending = true; draft.needsCheck = true; ++sequence; sync();
    try {
      const value = await api.post(base, body);
      if (!current()) return;
      if (!value || value.key !== body.key || value.todoId !== todo.id) throw new Error('未收到匹配的提交确认');
      snapshot = value; draft.key = ''; draft.needsCheck = false;
      notice.textContent = ''; paintState();
      Promise.resolve().then(() => store.refresh()).catch(() => {});
    } catch (error) {
      if (current()) notice.textContent = `提交未确认${error.status === 409 ? '（409 冲突）' : ''}：${error.message}。选择和请求标识已保留，请先核对当前状态，不要盲目重试。`;
    } finally { draft.pending = false; if (current()) sync(); }
  } });
  anchor.addEventListener('change', () => {
    if (!current()) return;
    draft.anchorId = anchor.value; draft.person = ''; draft.key = ''; paintPeople();
  });
  person.addEventListener('change', () => {
    if (!current()) return;
    draft.person = person.value; draft.key = ''; paintPeople();
  });
  const drawer = openDrawer({ title: '跟踪回复', subtitle: todo.title,
    body: [h('p', { class: 'small muted', style: wrap }, '选择原消息和回复人。收到可验证的直接回复后，停止当前提醒；待办由你确认完成。采集范围可能不完整，仅同群或同话题不能证明已回复。'),
      Card({ title: '当前等待', body: state }),
      Card({ title: '选择已有来源', body: h('div', { class: 'stack', style: wrap }, h('div', { class: 'row row--wrap' }, h('div', { class: 'grow' }, query), search), sourceHint, Field({ label: '原消息', control: anchor }), preview, Field({ label: '等待谁', control: person }), personHint) }), notice],
    footer: [check, save], onClose: () => { alive = false; ++sequence; clearInterval(watch); if (active === handle) active = null; } });
  drawer.el.style.overflowWrap = 'anywhere';
  // Snapshot events must not replace the initial source read or acknowledge a failed write.
  const handle = { api, close: drawer.close, refresh: () => { if (loaded && !draft.needsCheck) return read(); } };
  active = handle;
  let wasPending = draft.pending;
  const watch = setInterval(() => {
    if (api.token?.() !== token) { drawer.close(); return; }
    // A previous drawer may still own the write. Reopening never submits it again.
    if (wasPending && !draft.pending && !loaded && current()) read(true);
    wasPending = draft.pending;
  }, 100);
  sync(); read(true);
  return handle;
}
