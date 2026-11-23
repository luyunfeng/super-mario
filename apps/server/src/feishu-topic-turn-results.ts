import { createHash } from 'node:crypto';
import { TopicInputReceiptNotReady } from './feishu-topic-input-receipts.ts';
import { isDeepStrictEqual } from 'node:util';
import { publicText } from '../../../plugins/agent-progress-card.ts';
import type { Store } from '../../../packages/plugin-sdk/src/index.ts';
import type { Approval, Json } from '../../../packages/protocol/src/index.ts';
import type { FeishuAgentInputTarget } from '../../../packages/protocol/src/bots.ts';
import type { EffectRecord } from '../../../packages/core/src/effects.ts';

const collection = 'feishu.topic-turn-results';
type Target = FeishuAgentInputTarget;
type Options = {
  valid(target: Target): boolean;
  read(target: Target, turnId: string): Promise<Json>;
  send(target: Target, text: string, key: string, guard: () => void): Promise<string>;
};
type StoreView = Pick<Store, 'get' | 'list' | 'put' | 'transaction'>;
const hash = (s: string) => createHash('sha256').update(s).digest('hex');
const id = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && value.trim() === value;
const object = (value?: Json) => value && typeof value === 'object' && !Array.isArray(value) ? value : undefined;

function turnFromAck(value: Json | undefined, target: Target) {
  const ack = object(value);
  if (ack?.requested === true && ack.accepted !== false && ack.state === undefined && ack.clientMessageId === target.topic!.inputId
    && ack.nativeSessionId === target.nativeSessionId && (ack.sessionId === undefined || ack.sessionId === target.sessionId)
    && id(ack.turnId)) return ack.turnId;
}

function approvedTurn(store: StoreView, approvalId: string) {
  const target = store.get<Target>('feishu.agent-input-targets', approvalId);
  if (target?.topic?.publishTurnResult !== true || !id(target.nativeSessionId) || !id(target.sessionId) || ![target.topic.inputId, target.topic.binding,
    target.topic.grant, target.topic.chatId, target.topic.threadId, target.topic.messageId].every(id)) return;
  const a = store.get<Approval>('approvals', approvalId);
  if (a?.id !== approvalId || a.kind !== 'input' || a.status !== 'completed' || !Number.isSafeInteger(a.version) || a.version < 1
    || a.params.publishTurnResult !== true || a.params.fixedInput !== true || a.params.id !== target.runId || a.todoId !== target.todoId
    || a.params.todoId !== target.todoId || (a.params.projectId ?? '') !== target.projectId
    || (['machineId', 'sessionId', 'nativeSessionId', 'executorId'] as const).some(field => a.params[field] !== target[field])
    || typeof a.params.text !== 'string' || !a.params.text.trim()) return;
  const key = 'approval:' + approvalId + ':' + a.version;
  const effect = store.get<EffectRecord>('effects', key);
  if (effect?.status !== 'confirmed' || effect.kind !== 'executor.input' || effect.key !== key || effect.target !== target.runId
    || effect.fingerprint !== hash(JSON.stringify([effect.kind, effect.target, { text: a.params.text.trim() }]))) return;
  const turnId = turnFromAck(a.result, target);
  if (turnId && turnFromAck(effect.result, target) === turnId) return { target, turnId, version: a.version, fingerprint: effect.fingerprint };
}

type Progress = {
  approvalId: string; delivery: string; answerHash: string; publicHash: string; proofHash: string; totalParts: number; replies: string[];
};

export function createTopicTurnResults(store: StoreView, options: Options) {
  let closed = false;
  const jobs = new Map<string, Promise<void>>();
  async function check(approvalId: string) {
    if (closed) return;
    const proof = approvedTurn(store, approvalId);
    if (!proof) return;
    const { target, turnId } = proof;
    const key = hash(JSON.stringify([target.machineId, target.sessionId, target.nativeSessionId, turnId, target.topic!.inputId]));
    const previous = store.get<Progress>(collection, key);
    if ((previous && (previous.delivery !== 'partial' || previous.approvalId !== approvalId)) || !options.valid(target)) return;
    let raw: Json;
    try { raw = await options.read(target, turnId); }
    catch { return; } // A read-only lookup may be retried after a disconnect.
    const answer = object(raw);
    if (!answer || answer.source !== 'codex-app-server'
      || answer.sessionId !== target.sessionId || answer.nativeSessionId !== target.nativeSessionId || answer.turnId !== turnId
      || answer.clientMessageId !== target.topic!.inputId) return;

    const authorized = () => !closed && isDeepStrictEqual(approvedTurn(store, approvalId), proof) && options.valid(target);
    if (answer.state === 'failed') {
      store.transaction(() => {
        const row = store.get<Progress>(collection, key);
        if (authorized() && (!row || row.delivery === 'partial' && row.approvalId === approvalId))
          store.put(collection, key, { ...row, approvalId, turnId, delivery: 'turn-failed' });
      });
      return;
    }
    if (answer.state !== 'completed' || typeof answer.text !== 'string' || !answer.text.trim()) return;
    const clean = publicText(answer.text, Number.MAX_SAFE_INTEGER);
    if (!clean) return;
    const reply = '负责会话答复\n\n' + clean;
    const chars = Array.from(reply), size = 4000, totalParts = Math.ceil(chars.length / size);
    const evidence = { approvalId, turnId, nativeSessionId: target.nativeSessionId, inputId: target.topic!.inputId,
      answerHash: hash(answer.text), publicHash: hash(reply), proofHash: hash(JSON.stringify(proof)), totalParts };
    const matches = (row: Progress) => row.answerHash === evidence.answerHash && row.proofHash === evidence.proofHash
      && row.publicHash === evidence.publicHash && row.totalParts === totalParts;
    if (previous && !matches(previous)) {
      store.transaction(() => {
        if (authorized() && isDeepStrictEqual(store.get(collection, key), previous))
          store.put(collection, key, { ...previous, delivery: 'source-changed' });
      });
      return;
    }
    let index = previous?.replies?.length ?? 0;
    while (index < totalParts && !closed) {
      const claimed = store.transaction(() => {
        if (!authorized()) return;
        const row = store.get<Progress>(collection, key);
        if (row && (row.delivery !== 'partial' || row.approvalId !== approvalId || row.replies.length !== index)) return;
        if (row && !matches(row)) return;
        if (!row && index !== 0) return;
        // Only the gap after a confirmed ID and before claiming the next part is resumable.
        const next = { ...evidence, delivery: 'unknown', replies: row?.replies ?? [] };
        store.put(collection, key, next);
        return next;
      });
      if (!claimed) return;
      const guard = () => {
        if (!authorized()) throw Object.assign(new Error('负责人、输入审批或原话题已变化。'), { delivery: 'no' });
      };
      let messageId: string;
      try {
        guard();
        const part = chars.slice(index * size, (index + 1) * size).join('');
        messageId = await options.send(target, part, 'feishu-topic-turn:' + key + ':' + index, guard);
      } catch (error) {
        // The controller raises this only before entering the first platform send.
        if (error instanceof TopicInputReceiptNotReady)
          store.put(collection, key, { ...claimed, delivery: 'partial' });
        else if (error && typeof error === 'object' && 'delivery' in error && error.delivery === 'no')
          store.put(collection, key, { ...claimed, delivery: 'failed' });
        return;
      }
      if (!id(messageId) || claimed.replies.includes(messageId)) return;
      index++;
      store.put(collection, key, { ...claimed, delivery: index === totalParts ? 'confirmed' : 'partial',
        replies: [...claimed.replies, messageId] });
    }
  }
  function changed(approvalId: string): Promise<void> {
    if (closed) return Promise.resolve();
    const existing = jobs.get(approvalId);
    if (existing) return existing;
    const job = Promise.resolve().then(() => check(approvalId)).finally(() => jobs.delete(approvalId));
    jobs.set(approvalId, job);
    return job;
  }
  return {
    changed,
    async sweep() {
      if (closed) return;
      const approvals = store.list<Approval>('approvals').filter(a => a.kind === 'input' && a.status === 'completed' && a.params?.publishTurnResult === true);
      for (let i = 0; !closed && i < approvals.length; i += 4) {
        await Promise.all(approvals.slice(i, i + 4).map(a => changed(a.id)));
      }
    },
    async close() { closed = true; await Promise.allSettled([...jobs.values()]); },
  };
}
