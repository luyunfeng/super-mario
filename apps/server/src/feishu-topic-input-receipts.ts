import { createHash } from 'node:crypto';
import type { Store } from '../../../packages/plugin-sdk/src/index.ts';
import type { Approval, Json } from '../../../packages/protocol/src/index.ts';
import type { FeishuAgentInputTarget } from '../../../packages/protocol/src/bots.ts';
import type { EffectRecord } from '../../../packages/core/src/effects.ts';

const reports = 'feishu.topic-input-receipts';
const messages = {
  sent: '执行机会话已收到这条输入。',
  unsent: '这条输入未发送到执行机会话。',
  rejected: '输入审批已拒绝，这条输入未发送。',
  unknown: '这条输入的送达结果未知。',
};

function ack(result?: Json) {
  if (!result || typeof result !== 'object' || Array.isArray(result)) return 'unknown';
  if (result.accepted === false || result.requested === false) return result.requested === true ? 'unknown' : 'unsent';
  // executor.input returns requested:true only after both writing the text and pressing Enter.
  return result.requested === true ? 'sent' : 'unknown';
}

function outcome(a: Approval, target: FeishuAgentInputTarget, effect?: EffectRecord): keyof typeof messages {
  if (!effect) return a.status === 'rejected' ? 'rejected' : a.status === 'failed' ? 'unsent' : 'unknown';
  if (effect.kind !== 'executor.input' || effect.target !== target.runId || effect.key !== 'approval:' + a.id + ':' + a.version
    || a.kind !== 'input' || a.params.id !== target.runId || typeof a.params.text !== 'string') return 'unknown';
  const fingerprint = createHash('sha256').update(JSON.stringify([effect.kind, target.runId, { text: a.params.text.trim() }])).digest('hex');
  if (effect.fingerprint !== fingerprint || a.status === 'rejected') return 'unknown';
  if (effect.status === 'failed') return 'unsent';
  if (effect.status !== 'confirmed') return 'unknown';
  const confirmed = ack(effect.result);
  if (a.status === 'completed' && ack(a.result) !== confirmed) return 'unknown';
  return confirmed;
}

// Only the controller, before its first adapter.send call, can prove that no platform I/O began.
export class TopicInputReceiptNotReady extends Error {}

/** send must revalidate the live enrollment and reply to this specific source message. */
export function createTopicInputReceipts(store: Pick<Store, 'get' | 'put' | 'list' | 'transaction'>, options: {
  ready?(target: FeishuAgentInputTarget): boolean;
  send(target: FeishuAgentInputTarget, text: string, key: string): Promise<string>;
}) {
  let closed = false;
  const waiting = new Set<string>();
  const jobs = new Set<Promise<void>>();
  async function report(id: string) {
    if (closed) return;
    const claim = store.transaction(() => {
      waiting.delete(id);
      const previous = store.get<{ delivery: string }>(reports, id);
      if (previous && previous.delivery !== 'waiting') return;
      const target = store.get<FeishuAgentInputTarget>('feishu.agent-input-targets', id);
      if (!target?.topic || ![target.topic.binding, target.topic.grant, target.topic.chatId, target.topic.threadId,
        target.topic.messageId, target.topic.inputId].every(value => typeof value === 'string' && value.trim())) return;
      const approval = store.get<Approval>('approvals', id);
      if (!approval || approval.id !== id || !['completed', 'failed', 'unknown', 'rejected'].includes(approval.status)) return;
      if (options.ready && !options.ready(target)) { waiting.add(id); return; }
      const effect = store.get<EffectRecord>('effects', 'approval:' + id + ':' + approval.version);
      const status = outcome(approval, target, effect);
      // A crash after this claim may follow a successful platform send. Never replay it.
      store.put(reports, id, { status, delivery: 'unknown' });
      return { target, status };
    });
    if (!claim) return;
    let messageId: string;
    try {
      messageId = await options.send(claim.target, messages[claim.status], 'feishu-topic-input-receipt:' + id);
    } catch (error) {
      if (error instanceof TopicInputReceiptNotReady) {
        store.put(reports, id, { status: claim.status, delivery: 'waiting' });
        waiting.add(id);
        return;
      }
      if (error && typeof error === 'object' && 'delivery' in error && error.delivery === 'no')
        store.put(reports, id, { status: claim.status, delivery: 'failed' });
      return;
    }
    if (typeof messageId === 'string' && messageId.trim())
      store.put(reports, id, { status: claim.status, delivery: 'confirmed', messageId });
  }
  function changed(id: string): Promise<void> {
    if (closed) return Promise.resolve();
    // Event listeners may run within the host transaction; read its committed state.
    const job = Promise.resolve().then(() => report(id)).finally(() => jobs.delete(job));
    jobs.add(job);
    return job;
  }
  return {
    changed,
    async retryReady() {
      for (const id of [...waiting]) await changed(id);
    },
    async sweep() {
      if (closed) return;
      for (const approval of store.list<Approval>('approvals')) {
        if (closed) break;
        await changed(approval.id);
      }
    },
    async close() { closed = true; await Promise.allSettled([...jobs]); },
  };
}
