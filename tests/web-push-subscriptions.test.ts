import assert from 'node:assert/strict';
import { createECDH } from 'node:crypto';
import { createServer } from 'node:http';
import test from 'node:test';
import { createStore } from '../packages/core/src/store.ts';
import { MAX_SUBSCRIPTIONS, forgetDevice, listSubscriptions, pushNotice, subscribe, unsubscribe, validDevice, validEndpoint, vapidKeys, type Notice } from '../packages/core/src/web-push-subscriptions.ts';

const SERVICE = 'https://push.example.invalid';
const OWNER = { kind: 'root' } as const;
const PHONE = { kind: 'device', id: 'phone' } as const;
const TABLET = { kind: 'device', id: 'tablet' } as const;
const SERVICE_OK = [/^https:\/\/push\.example\.invalid\/push\//];
const NOTICE: Notice = { tag: 'card:one#needs', title: '需要你决定', body: '合成的通知内容', url: '#chat', urgent: true, quiet: false };

/** A browser's keys, as a page would send them. */
function subscription(store: ReturnType<typeof createStore>, device: string) {
  const curve = createECDH('prime256v1');
  curve.generateKeys();
  return { endpoint: SERVICE + '/push/' + device, keys: { p256dh: curve.getPublicKey().toString('base64url'), auth: Buffer.alloc(16, 7).toString('base64url') },
    key: vapidKeys(store).public, browser: '  Chrome   on Linux ' };
}

test('the VAPID key pair is made once and kept', () => {
  const store = createStore(':memory:');
  const first = vapidKeys(store);
  assert.deepEqual(vapidKeys(store), first);
  assert.notEqual(vapidKeys(createStore(':memory:')).public, first.public, 'a new store makes its own');
  store.close();
});

test('a browser subscribes, renews, and is shown without its keys', () => {
  const store = createStore(':memory:');
  assert.equal(subscribe(store, OWNER, 'web-1', subscription(store, 'web-1'), SERVICE_OK).ok, true);
  const listed = listSubscriptions(store);
  assert.equal(listed.length, 1);
  assert.equal(listed[0]!.device, 'web-1');
  assert.equal(listed[0]!.browser, 'Chrome on Linux');
  assert.equal(listed[0]!.service, 'push.example.invalid');
  // The keys the browser gave are never shown.
  assert.equal('p256dh' in listed[0]!, false);
  assert.equal('auth' in listed[0]!, false);
  const createdAt = listed[0]!.createdAt;
  // Subscribing again with the same endpoint is a renewal: the creation time is kept.
  assert.equal(subscribe(store, OWNER, 'web-1', subscription(store, 'web-1'), SERVICE_OK).ok, true);
  assert.equal(listSubscriptions(store)[0]!.createdAt, createdAt);
  assert.equal(unsubscribe(store, OWNER, 'web-1'), true);
  assert.equal(unsubscribe(store, OWNER, 'web-1'), false);
  assert.equal(listSubscriptions(store).length, 0);
  store.close();
});

test('what is refused: an odd device id, an unknown service, keys a browser would not give, and an old key', () => {
  const store = createStore(':memory:');
  assert.equal(validDevice('web-1'), true);
  assert.equal(validDevice(''), false);
  assert.equal(validDevice('a'.repeat(129)), false);
  assert.equal(validDevice('has space'), false);
  assert.deepEqual(subscribe(store, OWNER, 'has space', subscription(store, 'x'), SERVICE_OK), { ok: false, reason: 'device' });
  assert.equal(validEndpoint('https://fcm.googleapis.com/fcm/send/abc'), true);
  assert.equal(validEndpoint('https://fcm.googleapis.com/wp/abc'), true);
  assert.equal(validEndpoint('https://updates.push.apple.com/v2/abc'), true);
  assert.equal(validEndpoint('https://web.push.apple.com/QHabc123/'), true);
  assert.equal(validEndpoint('https://abc.push.mozilla.com/wpush/v2/abc'), true);
  assert.equal(validEndpoint('https://abc.notify.windows.com/w'), true);
  assert.equal(validEndpoint('https://fcm.googleapis.com.evil.example/fcm/send/abc'), false);
  assert.equal(validEndpoint('http://fcm.googleapis.com/fcm/send/abc'), false, 'not HTTPS');
  assert.equal(validEndpoint('https://user:pass@fcm.googleapis.com/fcm/send/abc'), false, 'user info');
  assert.equal(validEndpoint('https://evil.example/push'), false);
  assert.equal(validEndpoint('https://evil.example/push', [/^https:\/\/evil\.example\//]), true);
  const good = subscription(store, 'web-1');
  assert.equal(subscribe(store, OWNER, 'web-1', good, SERVICE_OK).ok, true);
  assert.deepEqual(subscribe(store, OWNER, 'web-2', { ...good, endpoint: 'https://evil.example/push' }, SERVICE_OK), { ok: false, reason: 'endpoint' });
  assert.deepEqual(subscribe(store, OWNER, 'web-2', { ...good, keys: { ...good.keys, auth: 'short' } }, SERVICE_OK), { ok: false, reason: 'keys' });
  assert.deepEqual(subscribe(store, OWNER, 'web-2', { ...good, key: 'another-key' }, SERVICE_OK), { ok: false, reason: 'key_changed', key: vapidKeys(store).public });
  store.close();
});

test('a subscription a paired device made is that device\'s alone', () => {
  const store = createStore(':memory:');
  assert.equal(subscribe(store, PHONE, 'web-1', subscription(store, 'web-1'), SERVICE_OK).ok, true);
  // Another device may not replace it with another endpoint, nor drop it without proving it holds the endpoint.
  assert.deepEqual(subscribe(store, TABLET, 'web-1', subscription(store, 'web-1-other'), SERVICE_OK), { ok: false, reason: 'owned' });
  assert.equal(unsubscribe(store, TABLET, 'web-1'), false);
  // The same endpoint proves the browser is the one that subscribed.
  assert.equal(unsubscribe(store, TABLET, 'web-1', SERVICE + '/push/web-1'), true);
  assert.equal(listSubscriptions(store).length, 0);
  // The owner's own token may do either.
  assert.equal(subscribe(store, PHONE, 'web-1', subscription(store, 'web-1'), SERVICE_OK).ok, true);
  assert.equal(unsubscribe(store, OWNER, 'web-1'), true);
  store.close();
});

test('a revoked device loses its subscriptions; one the owner made stays', () => {
  const store = createStore(':memory:');
  subscribe(store, PHONE, 'web-1', subscription(store, 'web-1'), SERVICE_OK);
  subscribe(store, OWNER, 'web-2', subscription(store, 'web-2'), SERVICE_OK);
  forgetDevice(store, 'phone');
  assert.deepEqual(listSubscriptions(store).map(row => row.device), ['web-2']);
  store.close();
});

test('at most so many browsers are pushed to, and one more drops the one that renewed longest ago', () => {
  const store = createStore(':memory:');
  for (let i = 0; i < MAX_SUBSCRIPTIONS; i++) subscribe(store, OWNER, 'web-' + i, subscription(store, 'web-' + i), SERVICE_OK);
  assert.equal(listSubscriptions(store).length, MAX_SUBSCRIPTIONS);
  // web-0 was made first. A new browser takes its place.
  subscribe(store, OWNER, 'web-new', subscription(store, 'web-new'), SERVICE_OK);
  const devices = listSubscriptions(store).map(row => row.device);
  assert.equal(devices.length, MAX_SUBSCRIPTIONS);
  assert.equal(devices.includes('web-0'), false);
  assert.equal(devices.includes('web-new'), true);
  store.close();
});

test('the same endpoint under another device id is one subscription', () => {
  const store = createStore(':memory:');
  subscribe(store, OWNER, 'web-1', subscription(store, 'web-1'), SERVICE_OK);
  subscribe(store, OWNER, 'web-2', subscription(store, 'web-1'), SERVICE_OK);
  assert.deepEqual(listSubscriptions(store).map(row => row.device), ['web-2']);
  store.close();
});

test('a push is sent to the subscribed browsers with no page open, retried when that may pass, and a gone subscription is dropped', async () => {
  const store = createStore(':memory:');
  subscribe(store, OWNER, 'web-open', subscription(store, 'web-open'), SERVICE_OK);
  subscribe(store, OWNER, 'web-busy', subscription(store, 'web-busy'), SERVICE_OK);
  subscribe(store, OWNER, 'web-gone', subscription(store, 'web-gone'), SERVICE_OK);
  subscribe(store, OWNER, 'web-mute', subscription(store, 'web-mute'), SERVICE_OK);
  const posts: string[] = [];
  const service = createServer((req, res) => {
    const device = req.url!.split('/').at(-1)!;
    posts.push(device);
    // Busy answers 503 once, then takes it. Gone is no longer subscribed.
    if (device === 'web-busy' && posts.filter(row => row === device).length === 1) { res.writeHead(503).end('try later'); return; }
    if (device === 'web-gone') { res.writeHead(410).end('gone'); return; }
    res.writeHead(201).end('created');
  });
  await new Promise<void>(resolve => service.listen(0, '127.0.0.1', () => resolve()));
  const port = (service.address() as { port: number }).port;
  // The endpoints are told apart by device, so each one is routed to this service by its own path.
  for (const row of listSubscriptions(store)) {
    const kept = store.list<{ device: string; endpoint: string }>('notifications.web-push.subscriptions').find(item => item.device === row.device)!;
    store.put('notifications.web-push.subscriptions', row.device, { ...kept, endpoint: 'http://127.0.0.1:' + port + '/push/' + row.device });
  }
  const outcomes = await pushNotice(store, NOTICE, device => device !== 'web-mute', {
    openDevices: device => device === 'web-open', retryWaitsMs: [1], now: () => new Date('2026-11-27T00:00:00Z'),
  });
  service.closeAllConnections();
  await new Promise<void>((resolve, reject) => service.close(error => error ? reject(error) : resolve()));
  // Open and muted browsers were not pushed; busy was pushed twice and then went through.
  assert.equal(posts.includes('web-open'), false);
  assert.equal(posts.includes('web-mute'), false);
  assert.equal(posts.filter(row => row === 'web-busy').length, 2);
  assert.equal(posts.filter(row => row === 'web-gone').length, 1, 'a gone answer stands, and is not retried');
  const byDevice = Object.fromEntries(outcomes.map(row => [row.device, row]));
  assert.equal(byDevice['web-busy']!.ok, true);
  assert.equal(byDevice['web-gone']!.gone, true);
  assert.equal(byDevice['web-gone']!.ok, false);
  // How the last push went is kept for the settings page, and the gone subscription is dropped.
  assert.equal(listSubscriptions(store).find(row => row.device === 'web-busy')!.delivery?.ok, true);
  assert.equal(listSubscriptions(store).some(row => row.device === 'web-gone'), false);
  store.close();
});
