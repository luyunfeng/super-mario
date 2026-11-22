import test from 'node:test';
import assert from 'node:assert/strict';
const { createApi } = await import(new URL('../apps/web/js/lib/api.js', import.meta.url).href);
const { createConversationDrafts } = await import(new URL('../apps/web/js/lib/conversation-drafts.js', import.meta.url).href);

class StorageFixture {
  values = new Map<string, string>();
  blocked = false;
  full = false;
  getItem(k: string) { if (this.blocked) throw Error('unavailable'); return this.values.get(k) ?? null; }
  setItem(k: string, v: string) { if (this.blocked || this.full) throw Error('unavailable'); this.values.set(k, v); }
  removeItem(k: string) { if (this.blocked) throw Error('unavailable'); this.values.delete(k); }
}
function browser(t: test.TestContext) {
  const local = new StorageFixture(), session = new StorageFixture();
  const href = 'https://workbench.example/#chat';
  for (const [key, value] of Object.entries({ localStorage: local, sessionStorage: session, location: { href },
    history: { state: null, replaceState() {} } })) {
    const prior = Object.getOwnPropertyDescriptor(globalThis, key);
    Object.defineProperty(globalThis, key, { configurable: true, value });
    t.after(() => prior ? Object.defineProperty(globalThis, key, prior) : Reflect.deleteProperty(globalThis, key));
  }
  return { local, session };
}

function page() {
  const api = createApi();
  const listeners = new Set<() => void>();
  const view = { snapshot: null as null | { plugins: { id: string; status: string }[] }, snapshotOwner: null as string | null, unauthorized: false };
  const store = { view, subscribe: (fn: () => void) => { listeners.add(fn); return () => listeners.delete(fn); } };
  const drafts = createConversationDrafts({ api, store });
  function snapshot(status: string, owner = api.draftOwner()) {
    Object.assign(view, { snapshot: { plugins: [{ id: 'conversation-drafts', status }] }, snapshotOwner: owner });
    for (const listener of listeners) listener();
  }
  return { drafts, api, view, snapshot };
}

test('drafts are scoped to accepted snapshots, survive anonymous reload, and hold offline or disabled edits in memory', t => {
  const { local } = browser(t);
  const a = page(), key = 'main';
  a.drafts.write(key, '尚未上线');
  assert.ok(![...local.values.values()].includes('尚未上线'));
  a.snapshot('active');
  assert.ok([...local.values.values()].includes('尚未上线'));
  const fresh = page();
  assert.equal(fresh.drafts.owner(), a.drafts.owner());
  assert.equal(fresh.drafts.read(key), '');
  fresh.snapshot('active');
  assert.equal(fresh.drafts.read(key), '尚未上线');
  a.snapshot('disabled');
  a.drafts.write(key, '停用中的新稿');
  assert.equal(a.drafts.read(key), '停用中的新稿');
  assert.equal(fresh.drafts.read(key), '尚未上线');
  a.snapshot('active');
  assert.equal(fresh.drafts.read(key), '停用中的新稿');
  const anonymousOwner = a.drafts.owner();
  a.api.setToken('synthetic-account-a');
  assert.notEqual(a.drafts.owner(), anonymousOwner);
  assert.equal(a.drafts.read(key), '');
  a.drafts.write(key, '新凭据私有草稿');
  a.snapshot('active', anonymousOwner);
  assert.ok(![...local.values.values()].includes('新凭据私有草稿'));
  a.snapshot('active');
  assert.equal(fresh.drafts.read(key), '停用中的新稿');
  assert.ok([...local.values.values()].includes('新凭据私有草稿'));
  for (const k of local.values.keys()) assert.ok(!k.includes('synthetic-account-a'));
});

test('delayed clears compare the current persisted text across tabs, even after a disabled interval', t => {
  browser(t);
  const a = page(), b = page();
  a.snapshot('active'); b.snapshot('active');
  a.drafts.write('main', '提交稿');
  a.drafts.write('project:p', '另一个会话');
  b.drafts.write('main', '另一标签页新稿');
  a.drafts.clearIf('main', '提交稿');
  assert.equal(a.drafts.read('main'), '另一标签页新稿');
  a.snapshot('disabled');
  a.drafts.clearIf('main', '另一标签页新稿');
  b.drafts.write('main', '更新的草稿');
  a.snapshot('active');
  assert.equal(a.drafts.read('main'), '更新的草稿');
  a.drafts.clearIf('main', '更新的草稿');
  assert.equal(b.drafts.read('main'), '');
  assert.equal(a.drafts.read('project:p'), '另一个会话');
});

test('quota errors and private storage preserve local drafts without leaking them after a credential change', t => {
  const { local } = browser(t);
  const a = page(); a.snapshot('active'); a.drafts.write('main', '已存');
  local.full = true;
  a.drafts.write('main', '未存');
  assert.equal(a.drafts.read('main'), '未存');
  a.drafts.clearIf('main', '已存');
  assert.equal(a.drafts.read('main'), '未存');
  a.drafts.clearIf('main', '未存');
  assert.equal(a.drafts.read('main'), '');
  local.blocked = true;
  a.api.setToken('synthetic-new');
  assert.equal(a.drafts.read('main'), '');
  a.snapshot('active');
  a.drafts.write('main', '内存输入');
  assert.equal(a.drafts.read('main'), '内存输入');
  a.drafts.clearIf('main', '内存输入');
  assert.equal(a.drafts.read('main'), '');
});

test('legacy credential upgrades preserve expiry and anonymous expiry isolation; stale 401s cannot revoke a new owner', async t => {
  const { local } = browser(t);
  let clock = Date.now();
  t.mock.method(Date, 'now', () => clock);
  local.setItem('super-mario-token', JSON.stringify({ value: 'synthetic-existing', expiresAt: clock + 100 }));
  const api = createApi(), old = api.draftOwner();
  const record = JSON.parse(local.getItem('super-mario-token')!);
  assert.equal(record.expiresAt, clock + 100);
  assert.equal(record.owner, old);
  assert.equal(createApi().draftOwner(), old);
  clock += 100;
  assert.equal(api.token(), '');
  assert.notEqual(api.draftOwner(), old);
  assert.equal(createApi().draftOwner(), api.draftOwner());

  const other = createApi();
  other.setToken('synthetic-known');
  api.setToken('synthetic-known');
  assert.equal(api.draftOwner(), other.draftOwner());
  let respond!: (response: Response) => void, notifications = 0;
  t.mock.method(globalThis, 'fetch', () => new Promise<Response>(resolve => { respond = resolve; }));
  api.onUnauthorized(() => { notifications++; });
  const pending = api.get('/state');
  api.setToken('synthetic-replacement');
  respond(new Response('{}', { status: 401 }));
  await assert.rejects(pending, { status: 401 });
  assert.equal(notifications, 0);
  const current = api.get('/state');
  respond(new Response('{}', { status: 401 }));
  await assert.rejects(current, { status: 401 });
  assert.equal(notifications, 1);
});
