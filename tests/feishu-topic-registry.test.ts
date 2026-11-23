import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createTopicRegistry } from '../apps/server/src/feishu-topic-registry.ts';
import { createStore } from '../packages/core/src/store.ts';

function database(t: TestContext) {
  const dir = mkdtempSync(join(tmpdir(), 'topic-registry-')), file = join(dir, 'registry.db');
  const open = () => {
    const store = createStore(file);
    t.after(() => store.close());
    return createTopicRegistry(store);
  };
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return open;
}

test('主群按显式选择或登记顺序产生；严格登记即使放宽策略也不自动成为主群', t => {
  const open = database(t), r = open(), b = 'fixture-owner-a';
  const strict = r.replace(b, 0, [{ chatId: 'strict', requireOwnerMention: true }]);
  assert.equal(strict.items[0].home, false);
  const grant = r.grant(b, 'strict');
  assert.ok(grant);
  const mixed = r.replace(b, strict.version, [{ chatId: 'strict', requireOwnerMention: false }, { chatId: 'relaxed' }]);
  assert.deepEqual(mixed.items.map(i => i.home), [false, true]);
  const marked = r.replace(b, mixed.version, [{ chatId: 'strict', home: true }, { chatId: 'relaxed' }]);
  assert.equal(marked.items[0].home, true);
  const reordered = r.replace(b, marked.version, [{ chatId: 'relaxed' }, { chatId: 'strict', name: ' 工作群 ' }]);
  assert.deepEqual(reordered.items.map(i => i.home), [false, true]);
  assert.equal(reordered.items[1].name, '工作群');
  assert.equal(reordered.items[1].addedAt, strict.items[0].addedAt);
  assert.equal(r.grant(b, 'strict'), grant);
  assert.equal('grant' in reordered.items[1], false);
  const implicit = r.replace(b, reordered.version, [{ chatId: 'strict', home: false }, { chatId: 'relaxed' }]);
  assert.deepEqual(implicit.items.map(i => i.home), [false, true]);
  assert.deepEqual(open().read(b), implicit);
});

test('相同事件跨连接重放不改列表，重新登记有新的授权，旧 Web 版本冲突', t => {
  const open = database(t), a = open(), b = open(), owner = 'pair-1';
  assert.match(a.command(owner, 'oc_group', 'on', 'on')!, /已登记/);
  const v = b.read(owner), grant = b.grant(owner, 'oc_group');
  assert.ok(grant);
  assert.match(b.command(owner, 'oc_group', 'select', 'home')!, /设为/);
  assert.equal(b.grant(owner, 'oc_group'), grant);
  assert.throws(() => a.replace(owner, v.version, []), { status: 409 });
  assert.match(b.command(owner, 'oc_group', 'out', 'off')!, /退出/);
  assert.equal(a.command(owner, 'oc_group', 'on', 'on'), undefined);
  assert.equal(a.grant(owner, 'oc_group'), undefined);
  assert.match(a.command(owner, 'oc_group', 'new-on', 'home')!, /主话题群/);
  assert.notEqual(a.grant(owner, 'oc_group'), grant);
  assert.equal(b.command(owner, 'oc_group', 'out', 'off'), undefined);
  assert.equal(b.read(owner).items.length, 1);
  assert.deepEqual(a.read('pair-2'), { version: 0, items: [] });
  assert.equal(a.grant('pair-2', 'oc_group'), undefined);
});

test('50 群上限、无变更命令及 Web 非法更新不改变现有版本', t => {
  const r = database(t)(), owner = 'pair-bound';
  const inputs = Array.from({ length: 50 }, (_, i) => ({ chatId: 'oc_' + i }));
  const full = r.replace(owner, 0, inputs);
  assert.equal(r.replace(owner, full.version, inputs).version, full.version);
  assert.match(r.command(owner, 'oc_other', 'try-home', 'home')!, /上限/);
  assert.match(r.command(owner, 'oc_2', 'repeat', 'on')!, /已是/);
  assert.deepEqual(r.read(owner), full);
  for (const invalid of [[...inputs, { chatId: 'extra' }], [{ chatId: 'bad id' }], [{ chatId: '同'.repeat(34) }],
    [{ chatId: 'same' }, { chatId: ' same ' }], [{ chatId: 'a', home: true }, { chatId: 'b', home: true }],
    [{ chatId: 'a', requireOwnerMention: 'true' }]]) {
    assert.throws(() => r.replace(owner, full.version, invalid as typeof inputs), { status: 400 });
    assert.deepEqual(r.read(owner), full);
  }
  r.command(owner, 'oc_0', 'free', 'off');
  assert.equal(r.command(owner, 'oc_other', 'try-home', 'home'), undefined);
  assert.equal(r.grant(owner, 'oc_other'), undefined);
});
