import { Button } from '../ui/kit.js';

const hex = bytes => Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('');
const digest = value => hex(globalThis.sha256(new TextEncoder().encode(value)));
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
function newId() {
  if (crypto.randomUUID) return crypto.randomUUID();
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6] & 15) | 64;
  bytes[8] = (bytes[8] & 63) | 128;
  const id = hex(bytes);
  return [id.slice(0, 8), id.slice(8, 12), id.slice(12, 16), id.slice(16, 20), id.slice(20)].join('-');
}

// Only unresolved submissions live in this tab. Body/quote fingerprints do not retain the text.
export function createMessageSubmissions({ api, context, onConfirmed, onStatus, captureEdit }) {
  const memory = new Map(), posting = new Set();
  let visibleKey = '', generation = 0;
  const button = Button({ label: '核对发送回执', size: 'sm', onClick: check });
  button.hidden = true;
  const path = ctx => ctx.key && ctx.owner ? 'sm.message-submissions.' + JSON.stringify([ctx.owner, ctx.key]) : '';
  const imageKey = images => images.map(({mime,bytes,sha256})=>[mime,bytes,sha256]);
  const draftDigest = ctx => digest(JSON.stringify([ctx.draft, ctx.captured, ...(ctx.images?.length ? [imageKey(ctx.images)] : [])]));
  const messageHash = (text, images) => digest(JSON.stringify(images?.length ? [text,imageKey(images)] : text));

  function entries(key) {
    if (!key) return [];
    if (!memory.has(key)) {
      let saved = [];
      try {
        const data = JSON.parse(sessionStorage.getItem(key));
        if (Array.isArray(data)) saved = data.filter(r => r && uuid.test(r.id) && typeof r.hash === 'string' && typeof r.draft === 'string');
      } catch { /* Session storage may be unavailable. */ }
      memory.set(key, saved);
    }
    return memory.get(key);
  }
  function save(key, rows) {
    memory.set(key, rows);
    try {
      if (rows.length) sessionStorage.setItem(key, JSON.stringify(rows));
      else sessionStorage.removeItem(key);
    } catch { /* Keep outstanding receipts in this page when storage is unavailable. */ }
  }
  function update() {
    const key = path(context());
    if (key !== visibleKey) { visibleKey = key; generation++; }
    const rows = entries(key);
    button.hidden = !rows.some(row => !posting.has(row.id));
  }
  function begin(ctx) {
    if (typeof globalThis.sha256 !== 'function') {
      onStatus('发送组件未加载，请刷新后重试。草稿已保留。');
      return null;
    }
    const key = path(ctx), rows = entries(key), hash = messageHash(ctx.body,ctx.images);
    let record = rows.find(row => row.hash === hash);
    if (!record) {
      record = { id: newId(), hash, draft: '', blocked: false };
      rows.push(record);
    }
    if (!record.blocked) {
      record.draft = draftDigest(ctx);
      posting.add(record.id);
    }
    save(key, rows);
    update();
    return { key, record };
  }
  function finish(ticket) {
    posting.delete(ticket.record.id);
    update();
  }
  function block(ticket) {
    ticket.record.blocked = true;
    save(ticket.key, entries(ticket.key));
  }
  function accepted(ticket, reply, ctx, legacy = false) {
    if (typeof reply?.id !== 'string' || !reply.id || reply.role !== 'user') return false;
    const keyed = reply.requestId !== undefined;
    if (keyed ? reply.requestId !== ticket.record.id : !legacy) return false;
    if ((keyed || reply.conversationId !== undefined) && reply.conversationId !== ctx.conversation) return false;
    if ((keyed || reply.projectId !== undefined) && (reply.projectId ?? null) !== (ctx.projectId ?? null)) return false;
    if ((reply.todoId ?? null) !== (ctx.todoId ?? null)) return false;
    if ((keyed || reply.text !== undefined) && (typeof reply.text !== 'string' || ticket.record.hash !== messageHash(reply.text,reply.images))) return false;
    if (!['done', 'pending'].includes(reply.status) && !(keyed && reply.status === 'failed')) return false;
    save(ticket.key, entries(ticket.key).filter(row => row.id !== ticket.record.id));
    update();
    return true;
  }
  async function check() {
    const ctx = context(), key = path(ctx), stamp = generation;
    if (!key) return;
    const current = () => {
      const now = context();
      return generation === stamp && path(now) === key && now.epoch === ctx.epoch;
    };
    const finishEdit = captureEdit();
    const result = [];
    for (const record of [...entries(key)]) {
      if (posting.has(record.id) || !current()) continue;
      try {
        const reply = await api.get(ctx.url + '/receipts/' + record.id);
        if (!current()) return;
        if (posting.has(record.id) || !entries(key).includes(record)) continue;
        if (!accepted({ key, record }, reply, ctx)) {
          block({ key, record });
          result.push('回执未确认受理，请核对对话。');
        } else {
          const now = context();
          if (record.draft === draftDigest(now) && record.hash === messageHash(now.body,now.images)) {
            finishEdit();
            onConfirmed(now);
          }
          result.push(reply.status === 'failed' ? '消息已受理，处理失败。' : reply.status === 'pending' ? '消息已受理，处理结果尚未确认。' : '消息已受理，处理完成。');
        }
      } catch (error) {
        if (!current()) return;
        if (posting.has(record.id) || !entries(key).includes(record)) continue;
        if (error.status === 404) {
          record.blocked = false;
          save(key, entries(key));
          result.push('未找到发送回执。可手动重试，原文将沿用原请求号。');
        } else result.push('无法核对发送回执：' + error.message);
      }
    }
    if (current() && result.length) onStatus(result.join(' '));
    update();
  }
  return { button, update, begin, finish, block, accepted,
    blocked: () => entries(path(context())).some(row => row.blocked) };
}
