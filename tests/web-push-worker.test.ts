import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { runInNewContext } from 'node:vm';

// The service worker runs here with a stand-in for the browser: the real file, its listeners
// registered on a fake self, and the pushes and clicks given to them by hand.
interface WorkerEvent { data?: { json(): unknown }; notification?: { close(): void; data?: { url?: string } }; waitUntil(p: Promise<unknown>): void }
type Listener = (event: WorkerEvent) => void;

async function worker(scope: string) {
  const source = await readFile(new URL('../apps/web/sw.js', import.meta.url), 'utf8');
  const listeners = new Map<string, Listener>();
  const shown: { title: string; options: Record<string, unknown> }[] = [];
  const closed: string[] = [];
  // Notifications the browser is showing, by tag, and what the worker closes.
  const onScreen = new Map<string, { tag: string; close(): void }>();
  let focused = '', opened = '';
  const self = {
    registration: {
      scope,
      showNotification: async (title: string, options: Record<string, unknown>) => {
        shown.push({ title, options });
        const tag = String(options.tag ?? '');
        onScreen.set(tag, { tag, close() { onScreen.delete(tag); closed.push(tag); } });
      },
      getNotifications: async (filter?: { tag?: string }) => [...onScreen.values()].filter(notification => !filter?.tag || notification.tag === filter.tag),
    },
    addEventListener: (type: string, listener: Listener) => listeners.set(type, listener),
    clients: {
      matchAll: async () => [{ url: scope + '#home', focus: async () => { focused = 'page'; }, navigate: async (target: string) => { opened = target; } }],
      openWindow: async (target: string) => { opened = target; },
      claim: async () => {},
    },
  };
  runInNewContext(source, { self, URL });
  let waited: Promise<unknown> = Promise.resolve();
  const fire = (type: string, event: Partial<WorkerEvent>) => { listeners.get(type)!(Object.assign(event, { waitUntil(p: Promise<unknown>) { waited = p; } }) as WorkerEvent); return waited; };
  // Objects the worker made belong to the other context, with its own Object.prototype; they are
  // brought over as plain data before they are compared.
  const plain = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
  return { shown, closed, fire, read: () => ({ focused, opened }), listeners: [...listeners.keys()], plain };
}

test('a push is shown as one notification, with a click going to the page it is about', async () => {
  const w = await worker('https://workbench.example/');
  assert.deepEqual(w.listeners.sort(), ['activate', 'notificationclick', 'push']);
  const payload = { v: 1, title: '需要你决定', body: '合成的通知内容', tag: 'card:one#needs', url: '#chat?interaction=synthetic', quiet: false };
  await w.fire('push', { data: { json: () => payload } });
  assert.deepEqual(w.plain(w.shown), [{ title: '需要你决定', options: {
    body: '合成的通知内容', tag: 'card:one#needs', icon: '/favicon.svg', silent: false, data: { url: 'https://workbench.example/#chat?interaction=synthetic' } } }]);
  // A quiet push is shown without a sound.
  await w.fire('push', { data: { json: () => ({ ...payload, quiet: true }) } });
  assert.equal(w.shown[1]!.options.silent, true);
  // A push with no readable payload is still one notification: one that shows nothing costs the subscription.
  await w.fire('push', { data: { json() { throw new Error('not JSON'); } } });
  assert.deepEqual(w.plain(w.shown[2]), w.plain({ title: 'super-mario', options: { body: '', icon: '/favicon.svg', silent: false, data: { url: 'https://workbench.example/' } } }));
  await w.fire('push', { data: undefined });
  assert.equal(w.shown.length, 4);
  // A long body is cut to what a notification shows.
  await w.fire('push', { data: { json: () => ({ ...payload, body: '长'.repeat(500) }) } });
  assert.equal((w.shown[4]!.options.body as string).length, 400);
  assert.ok((w.shown[4]!.options.body as string).endsWith('…'));
});

test('a click closes the notification and takes an open page to the notice; a page of another site is not opened', async () => {
  const w = await worker('https://workbench.example/');
  let closed = false;
  await w.fire('notificationclick', { notification: { close() { closed = true; }, data: { url: 'https://workbench.example/#chat?interaction=synthetic' } } });
  assert.equal(closed, true);
  assert.equal(w.read().focused, 'page');
  assert.equal(w.read().opened, 'https://workbench.example/#chat?interaction=synthetic');
  // A url that is not a hash route of the app is not followed: the owner is taken to the app instead.
  const other = await worker('https://workbench.example/');
  await other.fire('push', { data: { json: () => ({ title: 't', body: 'b', url: 'https://evil.example/' }) } });
  assert.deepEqual(other.plain(other.shown[0]!.options.data), { url: 'https://workbench.example/' });
  // A click with no data still goes to the app.
  await other.fire('notificationclick', { notification: { close() {}, data: undefined } });
  assert.equal(other.read().opened, 'https://workbench.example/');
});

test('a withdraw push takes the notification with its tag off the screen, and shows nothing', async () => {
  const w = await worker('https://workbench.example/');
  const payload = { v: 1, title: '需要你决定', body: '合成的通知内容', tag: 'card:one#needs', url: '#chat', quiet: false };
  await w.fire('push', { data: { json: () => payload } });
  await w.fire('push', { data: { json: () => ({ ...payload, tag: 'card:two#needs' }) } });
  assert.equal(w.shown.length, 2);
  // The decision was made: the first notification is taken back, and the second stays.
  await w.fire('push', { data: { json: () => ({ v: 1, kind: 'withdraw', title: '', body: '', tag: 'card:one#needs', url: '#home', quiet: true }) } });
  assert.deepEqual(w.closed, ['card:one#needs']);
  assert.equal(w.shown.length, 2, 'a withdraw shows nothing');
  // A withdraw for a notification that is not on the screen does nothing.
  await w.fire('push', { data: { json: () => ({ v: 1, kind: 'withdraw', title: '', body: '', tag: 'card:none#needs', url: '#home', quiet: true }) } });
  assert.deepEqual(w.closed, ['card:one#needs']);
});
