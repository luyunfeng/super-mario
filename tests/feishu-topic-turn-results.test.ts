import { TopicInputReceiptNotReady } from '../apps/server/src/feishu-topic-input-receipts.ts';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createStore } from '../packages/core/src/store.ts';
import { createTopicTurnResults } from '../apps/server/src/feishu-topic-turn-results.ts';
import type { Store } from '../packages/plugin-sdk/src/index.ts';
import type { Json } from '../packages/protocol/src/index.ts';

const topic = { binding: 'binding', grant: 'grant', chatId: 'group', threadId: 'group-thread', messageId: 'original', inputId: 'input', publishTurnResult: true };
const target = { topic, runId: 'run', sessionId: 'local-session', machineId: 'machine', nativeSessionId: 'native-session', executorId: 'executor',
  projectId: '', todoId: 'todo', botId: 'bot', appId: 'app', revision: 1, owner: {chatId:'private', senderId:'owner'} };
const ack = { requested: true, clientMessageId: topic.inputId, nativeSessionId: target.nativeSessionId, turnId: 'native-turn' };
const answer = { source: 'codex-app-server', state: 'completed', sessionId: target.sessionId, nativeSessionId: target.nativeSessionId,
  turnId: ack.turnId, clientMessageId: topic.inputId, text: '合成最终答复', log: '只供本地查看' };
const hash = (text: string) => createHash('sha256').update(text).digest('hex');
function seed(store: Store, id = 'approval') {
  const approval = { id, version: 2, kind: 'input', status: 'completed', todoId: target.todoId, result: ack, params: { id: target.runId, ...Object.fromEntries(
    ['machineId','sessionId','nativeSessionId','executorId','todoId'].map(k => [k, target[k as keyof typeof target]])),
    text: '合成输入', fixedInput: true, publishTurnResult: true } };
  const key = 'approval:' + id + ':2', effect = { key, kind: 'executor.input', status: 'confirmed', target: target.runId, result: ack,
    fingerprint: hash(JSON.stringify(['executor.input', target.runId, {text:'合成输入'}])) };
  store.put('approvals', id, approval); store.put('effects', key, effect); store.put('feishu.agent-input-targets', id, target);
  return {approval, effect};
}

test('审批、effect、目标与公开授权同时吻合才查最终答复', async t => {
  const store = createStore(':memory:'); t.after(() => store.close());
  let reads = 0;
  const service = createTopicTurnResults(store, { valid: () => true, read: async () => { reads++; return answer; },
    send: async () => { throw Error('unreachable'); } });
  const {approval, effect} = seed(store);
  const overrides = [
    ['approvals', approval.id, { ...approval, version: 3 }],
    ['approvals', approval.id, { ...approval, status: 'running' }],
    ['approvals', approval.id, { ...approval, params: { ...approval.params, publishTurnResult: undefined } }],
    ['approvals', approval.id, { ...approval, result: { ...ack, requested: false } }],
    ['approvals', approval.id, { ...approval, params: { ...approval.params, text: '不同输入' } }],
    ['approvals', approval.id, { ...approval, result: { ...ack, turnId:'wrong' } }],
    ['effects', effect.key, { ...effect, result: { ...ack, turnId: '' } }],
    ['effects', effect.key, { ...effect, status:'unknown' }],
    ['effects', effect.key, { ...effect, target:'another-run' }],
    ['effects', effect.key, { ...effect, result:{...ack,nativeSessionId:'other'} }],
    ['effects', effect.key, { ...effect, result:{...ack,clientMessageId:'other'} }],
    ['feishu.agent-input-targets', approval.id, {...target,topic:{...topic,publishTurnResult:undefined}}],
  ] as const;
  for (const [collection, id, value] of overrides) {
    seed(store); store.put(collection, id, value); await service.changed(approval.id);
  }
  assert.equal(reads, 0); await service.close();
});

test('只接受同一输入同一原生轮次最终正文，重启后可继续查询，重复事件只产生一次回传', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'sm-topic-turn-results-')), path = join(dir, 'test.sqlite');
  let store = createStore(path);
  t.after(async () => { store.close(); await rm(dir, { recursive: true, force:true }); });
  seed(store);
  let result: Json = { ...answer, state: 'running' }, reads = 0;
  const sends: string[] = [];
  function start() { return createTopicTurnResults(store, {
    valid: () => true, read: async (p, turnId) => {
      assert.deepEqual(p, target); assert.equal(turnId, ack.turnId); reads++; return result;
    }, send: async (p, text, _key, guard) => { guard(); assert.deepEqual(p.topic, topic); sends.push(text); return 'platform-' + sends.length; },
  }); }
  let service = start(); await service.sweep(); await service.close(); store.close();
  store = createStore(path); service = start();
  for (const patch of [{ source:'screen' }, { state:'unknown' }, { sessionId:'another-session' }, { turnId:'another-turn' },
    { clientMessageId:'other' }, { nativeSessionId:'different' }, { text:'   ' }]) {
    result = { ...answer, ...patch }; await service.sweep();
  }
  assert.equal(sends.length, 0);
  const text = '甲'.repeat(3991) + '🙂乙🙂' + '中'.repeat(5000);
  result = { ...answer, text };
  await Promise.all([service.changed('approval'), service.sweep(), service.sweep()]);
  assert.equal(sends.length, 3); assert.equal(Array.from(sends[0]!).length, 4000);
  assert.equal(sends.join(''), '负责会话答复\n\n' + text);
  assert.ok(sends.every(part => !/[\uD800-\uDFFF]/u.test(part) && Array.from(part).length <= 4000));
  const [stored] = store.list<{answerHash:string;delivery:string}>('feishu.topic-turn-results');
  assert.ok(stored); assert.equal(stored.answerHash, hash(text)); assert.equal(stored.delivery, 'confirmed');
  assert.ok(!JSON.stringify(stored).includes('只供本地查看'));
  seed(store, 'duplicate-approval');
  const before = reads;
  await service.close(); store.close(); store = createStore(path); service = start();
  await service.sweep(); assert.equal(reads,before); assert.equal(sends.length,3); await service.close();
});

test('撤权、来源竞态、失败轮次与未知外发都不会产生额外群答复', async t => {
  for (const scenario of ['revoked', 'mutated', 'guard', 'turn-failed', 'timeout', 'empty']) {
    await t.test(scenario, async t => {
      const store = createStore(':memory:'); t.after(() => store.close()); const {effect} = seed(store);
      let allowed = true, reads = 0, sends = 0;
      const opts = { valid: () => allowed, read: async () => {
        reads++;
        if (scenario === 'revoked') allowed = false;
        if (scenario === 'mutated') store.put('effects', effect.key, { ...effect, fingerprint:'invalid' });
        return { ...answer, ...(scenario === 'turn-failed' && {state:'failed'}) };
      }, send: async (_p: unknown, text: string, _key: string, guard: () => void) => {
        if (scenario === 'guard') allowed = false;
        guard(); sends++; assert.equal(text, '负责会话答复\n\n' + answer.text);
        if (scenario === 'timeout') throw Error('仅本地错误');
        return '';
      } };
      let service = createTopicTurnResults(store, opts);
      await service.sweep(); await service.close();
      service = createTopicTurnResults(store,opts); await service.sweep(); await service.close();
      assert.equal(reads,1); assert.equal(sends,['timeout','empty'].includes(scenario) ? 1 : 0);
    });
  }
});

test('扫描限制并发，关闭等待未返回的读取并阻断后续发送', async t => {
  const store = createStore(':memory:'); t.after(() => store.close());
  for (let i = 0; i < 12; i++) seed(store, 'test-' + i);
  let active = 0, reads = 0, sends = 0, release!: () => void, started!: () => void;
  const paused = new Promise<void>(resolve => { release = resolve; });
  const batch = new Promise<void>(resolve => { started = resolve; });
  const service = createTopicTurnResults(store, { valid: () => true, async read() {
    reads++; active++; assert.ok(active <= 4); if (active === 4) started();
    await paused; active--; return answer;
  }, async send() { sends++; return 'platform-id'; } });
  const sweep = service.sweep();
  await batch;
  let drained = false; const closing = service.close().then(() => { drained = true; });
  await Promise.resolve(); assert.equal(drained,false); release();
  await Promise.all([sweep, closing]); assert.equal(reads,4); assert.equal(sends,0);
});

test('跨重启只续发未尝试段，需复核全文与发布授权，未知段或复用回执均停止', async t => {
  for (const scenario of ['resume', 'changed-text', 'revoked', 'timeout', 'empty', 'duplicate-id']) {
    await t.test(scenario, async t => {
      const dir = await mkdtemp(join(tmpdir(), 'sm-topic-part-')), path = join(dir, 'test.sqlite');
      let store = createStore(path);
      t.after(async () => { store.close(); await rm(dir, { recursive:true, force:true }); });
      seed(store);
      let nativeText = '甲'.repeat(4200) + '乙'.repeat(3900) + '\nBearer fixtureSyntheticToken';
      let active = true;
      const keys: string[] = [], parts: string[] = [];
      function start() { return createTopicTurnResults(store, { valid: () => active, read: async () => ({ ...answer, text: nativeText }),
        async send(_target, text, key, guard) {
          guard(); keys.push(key); parts.push(text);
          if (parts.length === 1) void service.close(); // Shut down between confirmed parts.
          if (parts.length === 2) {
            if (scenario === 'timeout') throw Error('合成超时');
            if (scenario === 'empty') return '';
            if (scenario === 'duplicate-id') return 'message-1';
          }
          return 'message-' + parts.length;
        } }); }
      let service = start(); await service.sweep(); await service.close();
      assert.equal(parts.length,1);
      assert.deepEqual(store.list<{replies:string[]}>('feishu.topic-turn-results')[0]?.replies,['message-1']);
      store.close(); store = createStore(path);
      if (scenario === 'changed-text') nativeText += '变更';
      if (scenario === 'revoked') active = false;
      service = start(); await service.sweep(); await service.sweep(); await service.close();
      assert.equal(new Set(keys).size, keys.length);
      if (scenario === 'resume') {
        assert.equal(parts.length,3); assert.equal(parts.join(''), '负责会话答复\n\n' + nativeText.replace('fixtureSyntheticToken', '[凭证已隐藏]'));
      } else if (scenario === 'revoked' || scenario === 'changed-text') assert.equal(parts.length,1);
      else {
        assert.equal(parts.length,2);
        assert.deepEqual(store.list<{replies:string[]}>('feishu.topic-turn-results')[0]?.replies,['message-1']);
        assert.equal(store.list<{delivery:string}>('feishu.topic-turn-results')[0]?.delivery,'unknown');
      }
    });
  }
});

test('发送前断线可以在恢复后继续，平台只收到一次', async t => {
  const store = createStore(':memory:'); t.after(() => store.close());
  seed(store);
  let attempts = 0, delivered = 0;
  const service = createTopicTurnResults(store, { valid: () => true, read: async () => answer,
    async send() {
      if (++attempts === 1) throw new TopicInputReceiptNotReady();
      delivered++; return 'platform-id';
    } });
  await service.sweep(); await service.sweep(); await service.sweep(); await service.close();
  assert.equal(attempts, 2); assert.equal(delivered, 1);
});
