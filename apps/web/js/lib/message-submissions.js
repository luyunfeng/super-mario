import { createMessageOutbox } from './message-outbox.js';
import { Button } from '../ui/kit.js';

export const messageRequestLimit = 32 * 1024 * 1024;
export function messagePayload(ctx, fields) {
  if (!ctx.images?.length && !ctx.files?.length) return fields;
  const body = {...fields};
  if (ctx.files?.length) body.files = ctx.files.map(({uploadId}) => ({uploadId}));
  if (ctx.images?.length) {
    body.images = ctx.images.map(({mime,data}) => ({mime,data}));
    if (new Blob([JSON.stringify(body)]).size > messageRequestLimit)
      throw new Error('发送内容超过 32 MiB，请移除部分图片。');
  }
  return body;
}

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
export function createMessageSubmissions({ api, context, onConfirmed, onStatus, captureEdit, isRecoveryEnabled = () => false, canPersistDraft = () => false }) {
  const memory = new Map(), posting = new Set(), recovering = new Set();
  const outbox=createMessageOutbox({enabled:isRecoveryEnabled,persist:canPersistDraft,act:recover,render:update});
  let visibleKey = '', lastEnabled, generation = 0;
  const button = Button({ label: '核对发送回执', size: 'sm', onClick: check });
  button.hidden = true;
  const path = ctx => ctx.key && ctx.owner ? 'sm.message-submissions.' + JSON.stringify([ctx.owner, ctx.key]) : '';
  const imageKey = images => images.map(({mime,bytes,sha256})=>[mime,bytes,sha256]);
  const fileKey = files => files.map(({name,mime,bytes,sha256})=>[name,mime,bytes,sha256]);
  const attachments = (images,files) => [
    ...(images?.length ? [imageKey(images)] : []),
    ...(files?.length ? [{files:fileKey(files)}] : []),
  ];
  const draftDigest = ctx => digest(JSON.stringify([ctx.draft,ctx.captured,...attachments(ctx.images,ctx.files)]));
  const messageHash = (text,images,files) => digest(JSON.stringify(images?.length || files?.length ? [text,...attachments(images,files)] : text));

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
      if (rows.length) sessionStorage.setItem(key, JSON.stringify(rows.map(({reason,...row})=>row)));
      else sessionStorage.removeItem(key);
    } catch { /* Keep outstanding receipts in this page when storage is unavailable. */ }
  }
  function update() {
    const ctx=context(), key = path(ctx);
    const enabled = !!isRecoveryEnabled();
    if (key !== visibleKey || lastEnabled !== enabled) { visibleKey = key; lastEnabled = enabled; generation++; }
    const rows = entries(key);
    button.hidden = !rows.some(row => !posting.has(row.id));
    outbox.paint(ctx,rows.filter(row=>!posting.has(row.id)),id=>recovering.has(id));
  }
  function begin(ctx) {
    if (typeof globalThis.sha256 !== 'function') {
      onStatus('发送组件未加载，请刷新后重试。草稿已保留。');
      return null;
    }
    const key = path(ctx), rows = entries(key), hash = messageHash(ctx.body,ctx.images,ctx.files);
    let record = rows.find(row => row.hash === hash);
    const existing=!!record;
    if(record && recovering.has(record.id)) {onStatus('正在核对这次发送，请稍候。');return null;}
    if (!record) {
      record = { id: newId(), hash, draft: '', blocked: false };
      rows.push(record);
    }
    let saved;
    if (record.blocked && isRecoveryEnabled()) {
      // The composer will run the same authoritative receipt check as the row.
      record.blocked=false;
    }
    if (!record.blocked) {
      saved=outbox.remember(ctx,record.id);
      record.draft = draftDigest(ctx);
      posting.add(record.id);
    }
    save(key, rows);
    update();
    return { key, record, existing, saved, generation };
  }
  function finish(ticket) {
    posting.delete(ticket.record.id);
    update();
  }
  function block(ticket) {
    ticket.record.blocked = true;
    ticket.record.state = 'unknown';
    save(ticket.key, entries(ticket.key));
  }
  function matches(ticket, reply, ctx, legacy = false) {
    if (typeof reply?.id !== 'string' || !reply.id || reply.role !== 'user') return false;
    const keyed = reply.requestId !== undefined;
    if (keyed ? reply.requestId !== ticket.record.id : !legacy) return false;
    if ((keyed || reply.conversationId !== undefined) && reply.conversationId !== ctx.conversation) return false;
    if ((keyed || reply.projectId !== undefined) && (reply.projectId ?? null) !== (ctx.projectId ?? null)) return false;
    if ((reply.todoId ?? null) !== (ctx.todoId ?? null)) return false;
    if ((keyed || reply.text !== undefined) && (typeof reply.text !== 'string' || ticket.record.hash !== messageHash(reply.text,reply.images,reply.files))) return false;
    if (!['done', 'pending'].includes(reply.status) && !(keyed && reply.status === 'failed')) return false;
    return true;
  }
  function accepted(ticket,reply,ctx,legacy=false) {
    if (!matches(ticket,reply,ctx,legacy)) {
      if (reply?.status==='failed' && !reply.requestId && legacy) mark(ticket,'rejected');
      return false;
    }
    outbox.forget(ctx,ticket.record.id);
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
      if (posting.has(record.id) || recovering.has(record.id) || !current()) continue;
      recovering.add(record.id); update();
      try {
        const reply = await api.get(ctx.url + '/receipts/' + record.id);
        if (!current()) return;
        if (posting.has(record.id) || !entries(key).includes(record)) continue;
        if (!accepted({ key, record }, reply, ctx)) {
          block({ key, record });
          result.push('回执未确认受理，请核对对话。');
        } else {
          const now = context();
          if (record.draft === draftDigest(now) && record.hash === messageHash(now.body,now.images,now.files)) {
            finishEdit();
            onConfirmed(now);
          }
          result.push(reply.status === 'failed' ? '消息已受理，处理失败。' : reply.status === 'pending' ? '消息已受理，处理结果尚未确认。' : '消息已受理，处理完成。');
        }
      } catch (error) {
        if (!current()) return;
        if (posting.has(record.id) || !entries(key).includes(record)) continue;
        if (error.status === 404 && (error.code === 'MESSAGE_RECEIPT_NOT_FOUND' || !isRecoveryEnabled())) {
          record.state = 'missing';
          record.reason = '';
          record.blocked = false;
          save(key, entries(key));
          result.push('未找到发送回执。可手动重试，原文将沿用原请求号。');
        } else {
          if (isRecoveryEnabled()) mark({key,record},'unknown');
          result.push('无法核对发送回执：' + error.message);
        }
      } finally { recovering.delete(record.id); }
    }
    if (current() && result.length) onStatus(result.join(' '));
    update();
  }
  function mark(ticket,state,reason='') {
    if(!entries(ticket.key).includes(ticket.record)) return;
    ticket.record.state=state;
    // Keep server error text out of sessionStorage. It can contain a fragment of a draft.
    ticket.record.reason=reason;
    save(ticket.key,entries(ticket.key));
  }
  function failed(ticket,error) {
    const rejected=!error.receiptCheck && error.status>=400 && error.status<500 && !/结果未知|unknown/i.test(error.message);
    mark(ticket,rejected?'rejected':'unknown',rejected?error.message:'');
  }
  async function preflight(ticket,ctx) {
    const current=()=>isRecoveryEnabled() && generation===ticket.generation && path(context())===ticket.key &&
      context().epoch===ctx.epoch && entries(ticket.key).includes(ticket.record);
    if(ticket.saved) {
      const stored=await ticket.saved;
      if(!current()) throw new Error('原发件范围已变化');
      if(!stored) onStatus('原发件快照仅保留在当前页面。');
    }
    if(!ticket.existing || !isRecoveryEnabled()) return;
    if(!current()) throw new Error('原发件范围已变化');
    try {
      const reply=await api.get(ctx.url+'/receipts/'+ticket.record.id);
      if(!current()) throw new Error('原发件范围已变化');
      if(!matches(ticket,reply,ctx)) throw new Error('返回的回执无法确认原发件。');
      return reply;
    } catch(error) {
      if(error.status===404 && error.code==='MESSAGE_RECEIPT_NOT_FOUND' && current()) return;
      error.receiptCheck=true;
      throw error;
    }
  }
  async function recover(operation,ctx,record,payload) {
    const key=path(ctx), ticket={key,record,existing:true,generation};
    const stamp=generation;
    const current=()=>isRecoveryEnabled() && generation===stamp && path(context())===key && context().epoch===ctx.epoch && entries(key).includes(record);
    if(!current() || posting.has(record.id) || recovering.has(record.id)) return;
    if(operation==='remove') {
      outbox.forget(ctx,record.id);save(key,entries(key).filter(row=>row!==record));
      update();return;
    }
    recovering.add(record.id);update();
    try {
      let reply=await preflight(ticket,ctx);
      if(!current()) return;
      if(reply===undefined) {
        record.blocked=false;mark(ticket,'missing');
        if(operation!=='send') {onStatus('未找到发送回执。');return;}
        if(!payload || payload.projectId!==ctx.projectId || payload.todoId!==ctx.todoId ||
            messageHash(payload.text,payload.images,payload.files)!==record.hash)
          throw new Error('原发件内容无法核对，请重新选择原件。');
        const fields={text:payload.text,...(ctx.conversation==='main' && ctx.projectId && {projectId:ctx.projectId}),...(ctx.todoId && {todoId:ctx.todoId})};
        try {
          reply=await api.post(ctx.url,messagePayload(payload,fields),{'Idempotency-Key':record.id});
        } catch(error) {
          if(current()) {
            failed(ticket,error);
            onStatus(error.status===410?'原文件上传凭据已过期，请重新选择原件。':'重新发送未确认：'+error.message);
          }
          return;
        }
      }
      if(!current()) return;
      if(accepted(ticket,reply,ctx)) onStatus('原发件已受理。');
      else {block(ticket);onStatus('回执与原发件不一致，请核对对话。');}
    } catch(error) {
      if(current()) {mark(ticket,'unknown');onStatus('无法核对原发件：'+error.message);}
    } finally {
      recovering.delete(record.id);update();
    }
  }
  function forgetScope(owner,key){
    const ctx={owner,key},scope=path(ctx);
    if(!scope)return;
    memory.delete(scope);
    try {sessionStorage.removeItem(scope);} catch {/* No persisted receipts. */}
    void outbox.forgetScope(ctx);
    update();
  }
  return { forgetScope,panel:outbox.panel, failed, preflight, button, update, begin, finish, block, accepted,
    blocked: () => !isRecoveryEnabled() && entries(path(context())).some(row => row.blocked) };
}
