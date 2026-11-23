import { h } from '../lib/dom.js';
import { Button } from '../ui/kit.js';

export function turnRetryActive(store) {
  return !store.view.unauthorized && store.view.snapshot?.plugins?.some(p=>p.id==='conversation-retry' && p.status==='active');
}

// Retry the identified failed reply. The host resolves the original input,
// its attachments and scope, including on a retry after a lost response.
export function createTurnRetry(api,store) {
  const attempts = new Map();
  let owner;
  return function retryButton(reply, history, conversationId, receiptHref, isCurrent = () => true) {
    if (!turnRetryActive(store) || reply.conversationId !== conversationId || reply.role !== 'assistant' || reply.status !== 'failed' ||
        reply.retryable !== true || reply.stoppedByUser || !reply.replyTo) return null;
    const source = history?.find(m => m.id === reply.replyTo);
    if (!source?.directWebInput || source.role !== 'user' || source.status !== 'failed' || source.replyTo || source.stoppedByUser ||
        source.conversationId !== conversationId || source.projectId !== reply.projectId || source.todoId !== reply.todoId) return null;
    const identity = api.draftOwner();
    if (store.view.snapshotOwner !== identity) return null;
    if (owner !== identity) { owner = identity; attempts.clear(); }
    const receipt=history.find(m=>m.retryOf===reply.id && m.role==='user' && m.directWebInput &&
      m.conversationId===conversationId && m.projectId===source.projectId && m.todoId===source.todoId);
    if (receipt) {
      attempts.delete(reply.id);
      return h('span',{class:'row row--wrap'},'原对话已受理重试。',h('a',{href:receiptHref(receipt.id)},'查看重试消息'));
    }
    const notice = h('span', { role:'status' });
    const button = Button({label:'重试本轮',kind:'ghost',size:'sm',onClick:submit});
    function paint() {
      const state = attempts.get(reply.id);
      button.disabled = !!state?.busy || !!state?.accepted;
      notice.replaceChildren(state?.text || '');
      if (state?.accepted) notice.append(' ',h('a',{href:receiptHref(state.accepted)},'查看重试消息'));
    }
    if (attempts.has(reply.id)) attempts.get(reply.id).paint=paint;
    paint();
    async function submit() {
      if (!isCurrent() || !turnRetryActive(store) || store.view.snapshotOwner !== identity || api.draftOwner() !== identity || attempts.get(reply.id)?.busy || attempts.get(reply.id)?.accepted) return;
      const state = {busy:true,text:'正在提交重试…',paint};
      attempts.set(reply.id,state);paint();
      try {
        const input=await api.post('/messages/'+encodeURIComponent(reply.id)+'/retry',{conversationId});
        if (input?.role !== 'user' || !input.directWebInput || input.retryOf!==reply.id || typeof input.id !== 'string' || input.conversationId !== conversationId ||
          input.projectId !== source.projectId || input.todoId !== source.todoId || input.text !== source.text)
          throw new Error('重试回执与原消息不一致');
        state.accepted=input.id;
        state.text='原对话已受理重试。';
      } catch(error) {
        state.text=error.status && error.status<500 ? '重试未受理：'+error.message : '重试结果未知，请核对原对话。可用此按钮核对同一次重试。';
      } finally {
        state.busy=false;
        if (api.draftOwner()===identity && attempts.get(reply.id)===state) state.paint();
      }
    }
    return h('span',{class:'row row--wrap'},button,notice);
  };
}
