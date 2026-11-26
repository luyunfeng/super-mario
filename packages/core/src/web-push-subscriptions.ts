// The browsers that turned Web Push on, and the pushes sent to them. The protocol itself is in
// web-push.ts; this file is what the workbench keeps and decides.
import { newVapidKeys, postPush, pushTopic, readVapidKeys, subscriptionGone, validSubscriptionKeys, vapidAuthorization, encryptPush,
  type PushAnswer, type PushMessage, type PushSubscription, type VapidKeys } from './web-push.ts';
import type { Store } from '../../plugin-sdk/src/index.ts';

/** Where the subscriptions are kept: one document per browser, by its device id. */
const SUBSCRIPTIONS = 'notifications.web-push.subscriptions';
/** The VAPID key pair is one document in the settings collection. How the last push to each
 *  browser went is another, by the browser's device id. */
const KEYS = 'notifications.web-push.keys';
const DELIVERY_OF = (device: string) => 'notifications.web-push.delivery:' + device;
/** How many browsers are pushed to. One more drops the one that renewed longest ago. */
export const MAX_SUBSCRIPTIONS = 32;
/** How long a push service keeps a push for a browser that is away. */
export const PUSH_TTL_SECONDS = 24 * 60 * 60;
/** Where a push service may reach the sender (the VAPID sub claim). It is a mailbox for the
 *  project, and never the person who runs it. */
const VAPID_SUBJECT = 'mailto:super-mario@localhost.invalid';

/** One browser's subscription. `owner` is the paired device that made it, if one did. */
export interface StoredSubscription {
  /** The id a page makes for its browser. */
  device: string;
  /** The paired device the subscription belongs to, when one made it. Empty for the owner's own token. */
  owner: string;
  endpoint: string;
  p256dh: string;
  auth: string;
  /** The VAPID public key it was subscribed with. A change means the page must subscribe again. */
  key: string;
  /** What the page says of itself, for the settings page. */
  browser: string;
  createdAt: string;
  updatedAt: string;
}

/** A subscription as it is shown. The keys are never shown. */
export interface SubscriptionView {
  device: string; browser: string; createdAt: string; updatedAt: string;
  service: string;
  /** How the last push to it went. */
  delivery: { at: string; ok: boolean; detail: string } | undefined;
}

/** What is pushed, and where a click goes. */
export interface Notice {
  /** Tells notifications about one event apart, so a later one replaces the earlier. */
  tag: string;
  title: string;
  body: string;
  /** Where the page goes when the notification is clicked, as a hash route such as #chat. */
  url: string;
  /** Something waiting on the user goes at once. */
  urgent: boolean;
  /** Inside the quiet hours: shown without a sound. */
  quiet: boolean;
}

/** Who is asking. The same three an HTTP request can be made as. */
export type Asker = { kind: 'root' | 'local' } | { kind: 'device'; id: string };

/** Whether asker may change a subscription. One a paired device made is that device's alone. */
function owns(subscription: StoredSubscription, asker: Asker): boolean {
  return !subscription.owner || asker.kind !== 'device' || asker.id === subscription.owner;
}

/** The push services that are known. A subscription to any other is refused: a push would send
 *  the workbench's words to a server nobody chose. */
const KNOWN_SERVICES = [
  new RegExp('^https:\\/\\/fcm\\.googleapis\\.com\\/(?:fcm\\/send|wp)\\/'),
  new RegExp('^https:\\/\\/updates\\.push\\.apple\\.com\\/v[123]\\/'),
  new RegExp('^https:\\/\\/web\\.push\\.apple\\.com\\/QH[\\w-]+\\/'),
  new RegExp('^https:\\/\\/[^/]+\\.push\\.mozilla\\.com\\/'),
  new RegExp('^https:\\/\\/[^/]+\\.notify\\.windows\\.com\\/'),
];

/** Whether an endpoint is one of the known push services, over HTTPS. Tests pass their own. */
export function validEndpoint(endpoint: string, extra: RegExp[] = []): boolean {
  try {
    const url = new URL(endpoint);
    return url.protocol === 'https:' && !url.username && !url.password
      && [...KNOWN_SERVICES, ...extra].some(pattern => pattern.test(endpoint));
  } catch { return false; }
}

/** The service's host, for the settings page. */
function serviceOf(endpoint: string): string {
  try { return new URL(endpoint).host; } catch { return ''; }
}

/** The VAPID key pair, made the first time a browser asks for it and kept from then on. */
export function vapidKeys(store: Store): VapidKeys {
  const kept = readVapidKeys(store.get('settings', KEYS));
  if (kept) return kept;
  // Two pages asking at once both make a pair. The write is one transaction that reads first, so
  // what is stored first is the one that counts and the other is dropped.
  return store.transaction(() => {
    const made = newVapidKeys();
    const current = readVapidKeys(store.get('settings', KEYS));
    if (current) return current;
    store.put('settings', KEYS, made);
    return made;
  });
}

function list(store: Store): StoredSubscription[] {
  return store.list<StoredSubscription>(SUBSCRIPTIONS);
}

function saveAll(store: Store, subscriptions: StoredSubscription[]) {
  const kept = new Set(subscriptions.map(subscription => subscription.device));
  for (const subscription of list(store)) if (!kept.has(subscription.device)) store.remove(SUBSCRIPTIONS, subscription.device);
  for (const subscription of subscriptions) store.put(SUBSCRIPTIONS, subscription.device, subscription);
}

/** What the settings page is told of the browsers that are pushed to. */
export function listSubscriptions(store: Store): SubscriptionView[] {
  return list(store).map(subscription => ({
    device: subscription.device, browser: subscription.browser, createdAt: subscription.createdAt, updatedAt: subscription.updatedAt,
    service: serviceOf(subscription.endpoint),
    delivery: store.get<{ at: string; ok: boolean; detail: string }>('settings', DELIVERY_OF(subscription.device)),
  }));
}

/** A device id a page makes: printable, and bounded. */
export function validDevice(device: string): boolean {
  return /^[A-Za-z0-9._:-]{1,128}$/.test(device);
}

/** What a page sends to subscribe: the browser's PushSubscription, the key it used, and its own name. */
export interface SubscribeInput { endpoint: unknown; keys: unknown; key: unknown; browser: unknown }

/** The outcome of a subscribe, in words the page shows. */
export type SubscribeResult =
  | { ok: true; key: string }
  | { ok: false; reason: 'device' | 'endpoint' | 'keys' | 'key_changed' | 'owned'; key?: string };

/** Subscribes a browser, or renews its subscription. */
export function subscribe(store: Store, asker: Asker, device: string, input: SubscribeInput, extraServices: RegExp[] = []): SubscribeResult {
  if (!validDevice(device)) return { ok: false, reason: 'device' };
  const keys = vapidKeys(store);
  // Subscribed with a key the workbench no longer has, or never had. The page subscribes again.
  if (input.key !== keys.public) return { ok: false, reason: 'key_changed', key: keys.public };
  const endpoint = typeof input.endpoint === 'string' ? input.endpoint.trim() : '';
  if (!validEndpoint(endpoint, extraServices)) return { ok: false, reason: 'endpoint' };
  const subscriptionKeys = input.keys && typeof input.keys === 'object' ? input.keys as Record<string, unknown> : {};
  const p256dh = typeof subscriptionKeys.p256dh === 'string' ? subscriptionKeys.p256dh : '';
  const auth = typeof subscriptionKeys.auth === 'string' ? subscriptionKeys.auth : '';
  if (!validSubscriptionKeys({ endpoint, p256dh, auth })) return { ok: false, reason: 'keys' };
  const current = list(store).find(row => row.device === device);
  // A subscription a paired device made is that device's, unless the browser proves it holds the endpoint.
  if (current?.owner && !owns(current, asker) && current.endpoint !== endpoint) return { ok: false, reason: 'owned' };
  const now = new Date().toISOString();
  const next: StoredSubscription = {
    device, owner: asker.kind === 'device' ? asker.id : '', endpoint, p256dh, auth, key: keys.public,
    browser: typeof input.browser === 'string' ? input.browser.replace(/\s+/g, ' ').trim().slice(0, 64) : '',
    createdAt: current?.endpoint === endpoint ? current.createdAt : now, updatedAt: now,
  };
  // One browser's subscription is one row: the same endpoint under another device id (its storage
  // was cleared) goes. The rest are kept, newest renewal first, up to the most; so the one dropped
  // is the one that renewed longest ago. Two made in the same instant are told apart by device id,
  // so which one is dropped does not depend on how they happen to be stored.
  const others = list(store).filter(row => row.device !== device && row.endpoint !== endpoint)
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || b.device.localeCompare(a.device)).slice(0, MAX_SUBSCRIPTIONS - 1);
  saveAll(store, [next, ...others]);
  return { ok: true, key: keys.public };
}

/** Drops a browser's subscription. False when there was none, or when it is another device's. */
export function unsubscribe(store: Store, asker: Asker, device: string, endpoint?: string): boolean {
  const current = list(store).find(row => row.device === device);
  if (!current) return false;
  if (current.owner && !owns(current, asker) && (endpoint === undefined || endpoint !== current.endpoint)) return false;
  store.remove(SUBSCRIPTIONS, device);
  store.remove('settings', DELIVERY_OF(device));
  return true;
}

/** Drops every subscription a paired device made, when that device is revoked. */
export function forgetDevice(store: Store, deviceId: string) {
  for (const subscription of list(store)) if (subscription.owner === deviceId) unsubscribe(store, { kind: 'device', id: deviceId }, subscription.device);
}

/** What a browser is pushed, as the service worker reads it. */
export interface PushPayload {
  v: 1;
  title: string;
  body: string;
  /** The tag the page gives the same event, so the notification is replaced and taken back. */
  tag: string;
  /** Where the page goes when it is clicked, as a hash route. */
  url: string;
  quiet: boolean;
}

/** The most the words of a push take. The full text is in the page. */
const WORDS_MAX = 600;

/** The payload as it is sent, with its words shortened to fit one push. */
function fit(notice: Notice): PushPayload {
  const clip = (text: string, limit: number) => Array.from(text).length > limit ? Array.from(text).slice(0, limit - 1).join('') + '…' : text;
  return { v: 1, title: clip(notice.title, 200), body: clip(notice.body, WORDS_MAX), tag: notice.tag, url: notice.url, quiet: notice.quiet };
}

/** How one push went. */
export interface PushOutcome { device: string; status: number; ok: boolean; gone: boolean; detail: string }

export interface PushOptions {
  /** Tests let their own push service through and take the place of the network. */
  extraServices?: RegExp[];
  fetchImpl?: typeof fetch;
  /** Which browsers have a page open now. They are not pushed: the page notifies by itself. */
  openDevices?: (device: string) => boolean;
  /** How long to wait before another try, for a failure that may pass. */
  retryWaitsMs?: number[];
  now?: () => Date;
}

/** A failure that may pass is tried again: the network's, and the service's 429 and 5xx. */
function retryable(answer: PushAnswer): boolean {
  return answer.status === 0 || answer.status === 429 || answer.status >= 500;
}

/** Pushes one notice to the browsers that are subscribed, with no page open, and want it. */
export async function pushNotice(store: Store, notice: Notice, wants: (device: string) => boolean, options: PushOptions = {}): Promise<PushOutcome[]> {
  const subscriptions = list(store);
  const open = options.openDevices ?? (() => false);
  const targets = subscriptions.filter(subscription => !open(subscription.device) && wants(subscription.device));
  if (!targets.length) return [];
  const keys = vapidKeys(store);
  const payload = fit(notice);
  const plaintext = Buffer.from(JSON.stringify(payload));
  const message: PushMessage = { ttl: PUSH_TTL_SECONDS, urgency: notice.urgent ? 'high' : 'normal', topic: pushTopic(notice.tag) };
  const retryWaits = options.retryWaitsMs ?? [1000, 4000];
  const now = options.now ?? (() => new Date());
  return Promise.all(targets.map(async subscription => {
    const authorization = vapidAuthorization(subscription.endpoint, VAPID_SUBJECT, keys, now());
    let answer = await postPush(subscription.endpoint, message, encryptPush(subscription, plaintext), authorization, options.fetchImpl);
    for (const wait of retryWaits) {
      if (!retryable(answer)) break;
      await new Promise<void>(resolve => setTimeout(resolve, wait));
      answer = await postPush(subscription.endpoint, message, encryptPush(subscription, plaintext), vapidAuthorization(subscription.endpoint, VAPID_SUBJECT, keys, now()), options.fetchImpl);
    }
    const ok = answer.status >= 200 && answer.status < 300;
    const gone = subscriptionGone(answer);
    // How it went is kept for the settings page. The service's words are kept short.
    const detail = ok ? '' : (answer.networkError ?? answer.body.replace(/\s+/g, ' ').slice(0, 200)) || '推送服务没有接收';
    store.put('settings', DELIVERY_OF(subscription.device), { at: now().toISOString(), ok, detail });
    // The service says the subscription is no more. It is dropped while it is still that one.
    if (gone) {
      const current = list(store).find(row => row.device === subscription.device);
      if (current?.endpoint === subscription.endpoint) unsubscribe(store, { kind: 'root' }, subscription.device);
    }
    return { device: subscription.device, status: answer.status, ok, gone, detail };
  }));
}
