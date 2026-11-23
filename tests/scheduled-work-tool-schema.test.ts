import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSystemExtensions } from '../plugins/index.ts';
import { PluginHost, createContributions } from '../packages/core/src/plugin-host.ts';
import { createStore } from '../packages/core/src/store.ts';
import { createEventBus } from '../packages/core/src/events.ts';
import { createEventbox } from '../packages/core/src/eventbox.ts';
import { createSchedules } from '../packages/core/src/schedules.ts';
import { createApprovalService } from '../packages/core/src/approvals.ts';
import { createScheduledWork } from '../packages/core/src/scheduled-work.ts';
import type { JsonObject, Message } from '../packages/protocol/src/index.ts';
import type { ScheduledWorkInput } from '../packages/protocol/src/scheduled-work.ts';

async function fixture(t: test.TestContext) {
  const dir = await mkdtemp(join(tmpdir(), 'scheduled-work-schema-'));
  const store = createStore(join(dir, 'db.sqlite'));
  const events = createEventBus(store);
  const eventbox = createEventbox({ store, events });
  const schedules = createSchedules({ store, eventbox });
  const approvals = createApprovalService({ store, events, execute: async () => { throw new Error('No approval execution in schema tests'); } });
  const work = createScheduledWork({ store, events, schedules, enabled: () => true, authorize: () => true,
    proposeApproval: input => approvals.propose(input), brief: () => { throw new Error('No brief execution in schema tests'); } });
  const source: Message = { id: 'schema-user', role: 'user', conversationId: 'main', text: '创建工作提议', createdAt: new Date().toISOString() };
  store.put('messages', source.id, source);
  const contributions = createContributions();
  const host = new PluginHost({ store, contributions, dataDir: dir, events });
  let received: Record<string, unknown> | undefined;
  let receipt: unknown;
  const dailyBrief = createSystemExtensions({ demo: false, actions: {
    dispatch: () => { throw new Error('No dispatch in schema tests'); }, createTodo: () => null,
    scheduledWorkList: () => [], scheduledWorkCancel: () => null,
    scheduledWorkPropose: input => {
      received = input;
      receipt = work.propose(input as unknown as ScheduledWorkInput, source.id);
      return receipt as unknown as JsonObject;
    },
  } }).find(extension => extension.id === 'daily-brief')!;
  host.register(dailyBrief);
  await host.start();
  t.after(async () => {
    await host.close(); work.close(); await approvals.close(); schedules.close(); await eventbox.close();
    store.close(); await rm(dir, { recursive: true, force: true });
  });
  const registered = contributions.list('tools');
  const tool = registered.find(entry => entry.value.name === 'scheduled_work_propose')!.value;
  return { tool, registered, work, schedules, approvals, get received() { return received; }, get receipt() { return receipt; } };
}

function object(value: unknown): JsonObject {
  assert.ok(value && typeof value === 'object' && !Array.isArray(value));
  return value as JsonObject;
}
function branches(value: unknown): JsonObject[] {
  const schema = object(value);
  assert.equal(schema.type, 'object');
  assert.ok(Array.isArray(schema.oneOf));
  return schema.oneOf.map(object);
}
function assertBranch(schema: JsonObject, kind: string, fields: string[], required: string[]) {
  assert.equal(schema.type, 'object');
  assert.equal(schema.additionalProperties, false);
  assert.deepEqual(Object.keys(object(schema.properties)).sort(), ['kind', ...fields].sort());
  assert.deepEqual(schema.required, ['kind', ...required]);
  const discriminator = object(object(schema.properties).kind);
  assert.equal(discriminator.type, 'string');
  assert.deepEqual(discriminator.enum, [kind]);
}
const instant = '2099-12-01T09:00:00+08:00';
const timings: JsonObject[] = [
  { kind: 'once', at: instant },
  { kind: 'interval', everySec: 60 },
  { kind: 'cron', cron: '0 9 * * *', tz: 'Asia/Shanghai' },
];
const dispatch: JsonObject = { kind: 'dispatch', executorId: 'offline', prompt: '检查工作', doneWhen: '报告结果', expectMinutes: 0.5 };
const input = (key: string, schedule: JsonObject = timings[2]!, action: JsonObject = { kind: 'brief' }): JsonObject => ({ key, title: '简报提议', schedule, action });

test('registered proposal schema describes every strict timing/action branch and only its own required arguments', async t => {
  const f = await fixture(t);
  // Codex receives the parameters as JSON in its supplied tool definitions.
  const schema = object(JSON.parse(JSON.stringify(f.tool.parameters)));
  assert.equal(schema.type, 'object');
  assert.equal(schema.additionalProperties, false);
  assert.deepEqual(schema.required, ['key', 'title', 'schedule', 'action']);
  const props = object(schema.properties);
  assert.deepEqual(Object.keys(props).sort(), ['key', 'title', 'schedule', 'action', 'projectId', 'todoId'].sort());
  for (const name of ['key', 'title', 'projectId', 'todoId']) {
    assert.equal(object(props[name]).type, 'string');
    assert.equal(object(props[name]).minLength, 1);
    assert.equal(object(props[name]).pattern, '\\S');
  }
  const [once, interval, cron] = branches(props.schedule);
  assert.equal(branches(props.schedule).length, 3);
  assertBranch(once!, 'once', ['at', 'tz'], ['at']);
  assertBranch(interval!, 'interval', ['everySec', 'anchorAt', 'tz', 'until'], ['everySec']);
  assertBranch(cron!, 'cron', ['cron', 'tz', 'until'], ['cron', 'tz']);
  for (const branch of [once!, interval!, cron!]) {
    assert.equal(object(object(branch.properties).tz).type, 'string');
    assert.match(String(object(object(branch.properties).tz).description), /IANA.*Asia\/Shanghai/);
  }
  for (const field of [object(once!.properties).at, object(interval!.properties).anchorAt]) {
    const timestamp = object(field);
    assert.equal(timestamp.type, 'string');
    assert.equal(timestamp.format, 'date-time');
    assert.match(String(timestamp.description), /ISO 8601.*Z.*±HH:MM/);
    const pattern = new RegExp(String(timestamp.pattern));
    assert.ok(pattern.test(instant)); assert.ok(pattern.test('2099-12-01T01:00:00Z'));
    assert.equal(pattern.test('2099-12-01T09:00:00'), false);
  }
  const seconds = object(object(interval!.properties).everySec);
  assert.equal(seconds.type, 'integer'); assert.equal(seconds.minimum, 10); assert.equal(seconds.maximum, Number.MAX_SAFE_INTEGER);
  assert.match(String(object(object(cron!.properties).cron).description), /五段.*分 时 日 月 星期/);
  const [brief, action] = branches(props.action);
  assert.equal(branches(props.action).length, 2);
  assertBranch(brief!, 'brief', [], []);
  assertBranch(action!, 'dispatch', ['executorId', 'prompt', 'doneWhen', 'expectMinutes', 'cwd'], ['executorId', 'prompt', 'doneWhen', 'expectMinutes']);
  const minutes = object(object(action!.properties).expectMinutes);
  assert.equal(minutes.type, 'number'); assert.equal(minutes.exclusiveMinimum, 0); assert.equal(minutes.maximum, 10080);
  for (const field of ['executorId', 'prompt', 'doneWhen', 'cwd']) {
    const text = object(object(action!.properties)[field]);
    assert.equal(text.type, 'string'); assert.equal(text.minLength, 1); assert.equal(text.pattern, '\\S');
  }
  for (const name of ['scheduled_work_list', 'scheduled_work_cancel']) {
    assert.equal(f.registered.find(entry => entry.value.name === name)!.value.parameters.required, undefined);
  }
  assert.match(f.tool.description, /等待创建审批.*dispatch每次到期仍需独立派发审批/);
  const example = f.tool.description.match(/brief例子：(\{.*\})。/)![1]!;
  const args = object(JSON.parse(example));
  assert.deepEqual(args.schedule, timings[2]); assert.deepEqual(args.action, { kind: 'brief' });
  await f.tool.execute(args, new AbortController().signal);
  assert.equal(f.work.list()[0]!.status, 'pending');
  assert.equal(f.schedules.list().length, 0);
});

test('registered tool passes all timing/action combinations unchanged to strict core and returns pending approval', async t => {
  const f = await fixture(t);
  const signal = new AbortController().signal;
  const schedules = [...timings,
    { kind: 'once', at: instant, tz: 'Asia/Shanghai' },
    { kind: 'interval', everySec: 10, anchorAt: instant, tz: 'UTC' },
  ];
  for (const [i, schedule] of schedules.entries()) {
    for (const action of [{ kind: 'brief' }, dispatch, { ...dispatch, cwd: '/tmp', expectMinutes: 10080 }]) {
      const args = input(`valid-${i}-${action.kind}-${action.cwd ?? 'default'}`, schedule, action);
      const before = structuredClone(args);
      const result = await f.tool.execute(args, signal);
      assert.strictEqual(f.received, args);
      assert.strictEqual(result, f.receipt);
      assert.deepEqual(args, before);
      assert.equal(object(result).status, 'pending');
      const saved = f.work.list().at(-1)!;
      assert.deepEqual(saved.input.action, action);
      if (schedule.kind === 'interval' && schedule.anchorAt === undefined) {
        assert.ok(saved.input.schedule.kind === 'interval' && saved.input.schedule.anchorAt);
      } else assert.deepEqual(saved.input.schedule, schedule);
    }
  }
  assert.equal(f.work.list().length, 15);
  assert.equal(f.approvals.list().length, 15);
  assert.equal(f.schedules.list().length, 0);
});

test('schema advertises no aliases or host fields and actual tool leaves rejection to core', async t => {
  const f = await fixture(t);
  const invalid: JsonObject[] = [
    input('timezone-alias', { kind: 'cron', cron: '0 9 * * *', timezone: 'Asia/Shanghai' }),
    input('type-alias', timings[2], { type: 'brief' }),
    input('brief-fields', timings[2], { kind: 'brief', instructions: '汇总', projectId: 'p' }),
    input('kind-missing', { cron: '0 9 * * *', tz: 'Asia/Shanghai' }),
    input('once-fields', { kind: 'once', at: instant, everySec: 60 }),
    input('interval-fields', { kind: 'interval', everySec: 60, cron: '0 9 * * *' }),
    input('cron-tz-missing', { kind: 'cron', cron: '0 9 * * *' }),
    input('offset-missing', { kind: 'once', at: '2099-12-01T09:00:00', tz: 'Asia/Shanghai' }),
    input('anchor-offset-missing', { kind: 'interval', everySec: 60, anchorAt: '2099-12-01T09:00:00' }),
    input('tz-invalid', { kind: 'cron', cron: '0 9 * * *', tz: 'invalid/zone' }),
    input('cron-seconds', { kind: 'cron', cron: '0 0 9 * * *', tz: 'UTC' }),
    ...[9, 10.5, Number.MAX_SAFE_INTEGER + 1].map(everySec => input(`seconds-${everySec}`, { kind: 'interval', everySec })),
    ...[0, -1, 10081].map(expectMinutes => input(`minutes-${expectMinutes}`, timings[2], { ...dispatch, expectMinutes })),
    input('dispatch-missing', timings[2], { kind: 'dispatch', executorId: 'offline' }),
    input('dispatch-alias', timings[2], { ...dispatch, type: 'dispatch' }),
    { ...input('host-field'), sourceMessageId: 'forged' },
  ];
  for (const field of ['key', 'title', 'schedule', 'action']) {
    const missing = input(`missing-${field}`); delete missing[field]; invalid.push(missing);
  }
  for (const args of invalid) {
    const before = structuredClone(args);
    await assert.rejects(f.tool.execute(args, new AbortController().signal));
    assert.strictEqual(f.received, args);
    assert.deepEqual(args, before);
  }
  assert.equal(f.work.list().length, 0);
  assert.equal(f.approvals.list().length, 0);
  assert.equal(f.schedules.list().length, 0);
});
