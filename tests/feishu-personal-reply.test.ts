import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import type { ChildProcess } from 'node:child_process';
import { replyAsPersonalUser, PersonalReplyError } from '../plugins/feishu-personal-reply.ts';
import type { PersonalReplyCLI } from '../plugins/feishu-personal-reply.ts';

const input = { profile: 'verified-profile', messageId: 'om_original123', text: '  原文\n$SECRET `command` ; --profile other  ', key: 'effect_123-abc' };
function fixture(output: unknown = { data: { message_id: 'om_sent123' } }, options: { error?: Error; code?: number; signal?: string; stderr?: string; hold?: boolean } = {}) {
  let calls = 0;
  let killed = false;
  let ended = false;
  const child = new EventEmitter() as ChildProcess;
  Object.assign(child, { stdin: Object.assign(new EventEmitter(), { end() { ended = true; } }), kill() { killed = true; return true; } });
  let finish = () => {};
  const runner: PersonalReplyCLI = (file, args, config, callback) => {
    calls++;
    assert.equal(file, 'lark-cli');
    assert.deepEqual(args, ['--profile', input.profile, 'im', '+messages-reply', '--message-id', input.messageId, '--text', input.text, '--idempotency-key', input.key, '--as', 'user', '--format', 'json']);
    assert.equal(config.shell, false); assert.equal(config.timeout, 20_000); assert.equal(config.maxBuffer, 65536);
    assert.equal(config.killSignal, 'SIGKILL');
    finish = () => { callback(options.error ?? null, typeof output === 'string' ? output : JSON.stringify(output), options.stderr ?? ''); child.emit('close', options.code ?? (options.error ? 1 : 0), options.signal ?? null); };
    if (!options.hold) queueMicrotask(() => finish());
    return child;
  };
  return { runner, finish: () => finish(), calls: () => calls, killed: () => killed, ended: () => ended };
}
async function failure(promise: Promise<unknown>, delivery: string) {
  await assert.rejects(promise, error => {
    assert.ok(error instanceof PersonalReplyError); assert.equal(error.delivery, delivery);
    const exposed = `${error.stack} ${JSON.stringify(error)}`;
    for (const secret of [input.profile, input.text, 'SECRET', 'raw-sensitive']) assert.ok(!exposed.includes(secret));
    assert.equal(error.cause, undefined); return true;
  });
}
test('精确参数、显式身份、原文和幂等 key；仅返回消息 ID，单次调用并关闭 stdin', async () => {
  for (const data of [{ message_id: 'om_sent123' }, { message: { message_id: 'om_sent123' } }]) {
    const f = fixture({ ok: true, data, secret: 'raw-sensitive' });
    assert.deepEqual(await replyAsPersonalUser(input, f.runner), { messageId: 'om_sent123' });
    assert.equal(f.calls(), 1); assert.ok(f.ended());
  }
});
test('参数错误不执行，包括缺少 profile；边界不裁剪正文', async () => {
  for (const patch of [{ profile: '' }, { profile: '../bad' }, { profile: 'x'.repeat(129) }, { messageId: 'om_' }, { messageId: 'bad' }, { key: 'x'.repeat(51) }, { key: 'a b' }, { key: '' }, { text: '  ' }, { text: 'x'.repeat(20001) }]) {
    let calls = 0;
    await failure(replyAsPersonalUser({ ...input, ...patch }, () => { calls++; throw Error('raw-sensitive'); }), 'no');
    assert.equal(calls, 0);
  }
});
for (const [name, output, options, delivery] of [
  ['权限拒绝', { ok: false, error: { subtype: 'permission_denied' } }, {}, 'no'],
  ['认证拒绝 stderr', '', { error: Error('raw-sensitive'), stderr: JSON.stringify({ ok: false, error: { subtype: 'unauthorized' } }) }, 'no'],
  ['未知拒绝', { ok: false, error: { type: 'unknown' } }, {}, 'unknown'],
  ['冲突成功证据', { ok: false, error: { subtype: 'forbidden' }, data: { message_id: 'om_sent123' } }, {}, 'unknown'],
  ['网络', '', { error: Object.assign(Error('raw-sensitive'), { code: 'ECONNRESET' }) }, 'unknown'],
  ['超时', { ok: false, error: { subtype: 'forbidden' } }, { error: Object.assign(Error('raw-sensitive'), { killed: true }) }, 'unknown'],
  ['缺少程序', '', { error: Object.assign(Error('raw-sensitive'), { code: 'ENOENT' }) }, 'no'],
  ['不完整', '{', {}, 'unknown'], ['缺少 ID', { ok: true }, {}, 'unknown'],
  ['格式未知', [], {}, 'unknown'], ['无效 ID', { data: { message_id: 'bad' } }, {}, 'unknown'],
] as const) {
  test(`${name}：${delivery}，不泄露也不重试`, async () => {
    const f = fixture(output, options); await failure(replyAsPersonalUser(input, f.runner), delivery); assert.equal(f.calls(), 1);
  });
}
test('abort 等待子进程 close，即使迟到成功也报告 unknown', async () => {
  const controller = new AbortController(); const f = fixture(undefined, { hold: true });
  let settled = false;
  const result = replyAsPersonalUser({ ...input, signal: controller.signal }, f.runner);
  void result.then(() => { settled = true; }, () => { settled = true; });
  controller.abort(); await new Promise(resolve => setImmediate(resolve));
  assert.ok(f.killed()); assert.equal(settled, false);
  f.finish(); await failure(result, 'unknown'); assert.equal(f.calls(), 1);
});
test('预先中止不启动；同步异常不保留 cause', async () => {
  const controller = new AbortController(); controller.abort(); let calls = 0;
  await failure(replyAsPersonalUser({ ...input, signal: controller.signal }, () => { calls++; throw Error(); }), 'unknown');
  assert.equal(calls, 0);
  await failure(replyAsPersonalUser(input, () => { throw Error('raw-sensitive'); }), 'unknown');
});
