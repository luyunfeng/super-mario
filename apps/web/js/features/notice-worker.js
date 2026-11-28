// Web Push: what reaches this browser while no page of the workbench is open. The page's own
// system notification (browser-notifications.js) covers the case where a page is open; this is
// for when none is, and the server decides per browser whether a page is open.
//
// It needs a secure page (HTTPS, or localhost) and the browser's permission. Where either is
// missing the settings say so, and nothing pretends to work.
import { readLocal, writeLocal } from '../lib/dom.js';

const DEVICE_KEY = 'sm.web-push.device';
/** The name of the service worker's file, at the root of the site so that it covers every page. */
export const WORKER_URL = '/sw.js';

/** This browser's own id, made the first time it is needed and kept. It is what its push
 *  subscription and its presence heartbeat are both under. */
export function browserDevice() {
  let device = readLocal(DEVICE_KEY, '');
  if (typeof device !== 'string' || !/^[A-Za-z0-9._:-]{1,128}$/.test(device)) {
    device = 'web-' + [...crypto.getRandomValues(new Uint8Array(16))].map(byte => byte.toString(16).padStart(2, '0')).join('');
    writeLocal(DEVICE_KEY, device);
  }
  return device;
}

/** Why Web Push cannot work here, in a word the settings show; empty when it can. */
export function webPushProblem() {
  if (!window.isSecureContext) return 'insecure';
  if (!('serviceWorker' in navigator) || !('PushManager' in window) || !('Notification' in window)) return 'unsupported';
  return '';
}

/** The browser's own name, for the settings page. It says what it is; nothing more precise is asked. */
function browserName() {
  const agent = navigator.userAgent;
  const browser = /Edg\//.test(agent) ? 'Edge' : /OPR\//.test(agent) ? 'Opera' : /Firefox\//.test(agent) ? 'Firefox'
    : /Chrome\//.test(agent) ? 'Chrome' : /Safari\//.test(agent) ? 'Safari' : '';
  const system = /Windows/.test(agent) ? 'Windows' : /Mac OS X/.test(agent) ? 'macOS' : /Android/.test(agent) ? 'Android' : /Linux/.test(agent) ? 'Linux' : /iPhone|iPad/.test(agent) ? 'iOS' : '';
  return [browser, system].filter(Boolean).join(' on ');
}

/** The worker, registered once and kept. Resolves to undefined when there can be none. */
let workerPromise;
export function pushWorker() {
  if (webPushProblem()) return Promise.resolve(undefined);
  workerPromise ??= navigator.serviceWorker.register(WORKER_URL, { scope: '/' }).catch(() => undefined);
  return workerPromise;
}

/** Asks the browser for permission. Resolves to 'granted', 'denied' or 'default'. */
async function askPermission() {
  if (Notification.permission !== 'default') return Notification.permission;
  try { return await Notification.requestPermission(); } catch { return 'denied'; }
}

/** What the server says of this browser's subscription. */
export async function readSubscription(api) {
  const device = browserDevice();
  const status = await api('/push/web/' + encodeURIComponent(device));
  const stored = readLocal('sm.web-push.subscription', null);
  return { ...status, device, endpoint: typeof stored?.endpoint === 'string' ? stored.endpoint : '' };
}

/** Why a subscribe did not happen, in words. */
const REASONS = {
  insecure: '当前页面不是安全来源。浏览器只在 HTTPS 或 localhost 下提供推送。',
  unsupported: '这个浏览器不支持 Web Push。',
  denied: '浏览器不允许本站发通知。请在地址栏的网站设置里改成允许。',
  endpoint: '浏览器的推送服务不是工作台认识的那个，已拒绝订阅。',
  keys: '浏览器给出的推送密钥无效。',
  owned: '这个浏览器的通知是另一台配对设备设置的。请用那台设备，或先撤销它。',
  refused: '订阅被拒绝。',
};

/**
 * Subscribes this browser. Resolves to { ok: true } or { ok: false, reason, message }.
 * A key the server no longer has is not an error: the browser is subscribed again with the new one.
 */
export async function subscribePush(api) {
  const problem = webPushProblem();
  if (problem) return { ok: false, reason: problem, message: REASONS[problem] };
  const worker = await pushWorker();
  if (!worker) return { ok: false, reason: 'unsupported', message: REASONS.unsupported };
  const permission = await askPermission();
  if (permission !== 'granted') return { ok: false, reason: 'denied', message: REASONS.denied };
  const { key } = await api('/push/web');
  let subscription = await worker.pushManager.getSubscription();
  // Subscribed with a key the server no longer has: it is dropped, and made again with this one.
  if (subscription && !sameKey(new Uint8Array(subscription.options.applicationServerKey), base64Url(key))) {
    await subscription.unsubscribe();
    subscription = null;
  }
  subscription ??= await worker.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: base64Url(key) });
  const device = browserDevice();
  const sent = subscription.toJSON();
  const answer = await api('/push/web/' + encodeURIComponent(device), { method: 'PUT', body: {
    endpoint: sent.endpoint, keys: sent.keys, key, browser: browserName() } });
  writeLocal('sm.web-push.subscription', { endpoint: sent.endpoint });
  return { ok: true, answer };
}

/** Drops this browser's subscription, at the server and at the browser. */
export async function unsubscribePush(api) {
  const device = browserDevice();
  const stored = readLocal('sm.web-push.subscription', null);
  const answer = await api('/push/web/' + encodeURIComponent(device), { method: 'DELETE', body: { ...(stored?.endpoint ? { endpoint: stored.endpoint } : {}) } });
  writeLocal('sm.web-push.subscription', null);
  if (!webPushProblem()) {
    const worker = await pushWorker();
    const subscription = await worker?.pushManager.getSubscription();
    await subscription?.unsubscribe();
  }
  return answer;
}

/** Sends a test push to this browser, and says how the push service answered. */
export async function testPush(api) {
  const device = browserDevice();
  try {
    return await api('/push/web/' + encodeURIComponent(device) + '/test', { method: 'POST', body: {} });
  } catch (error) {
    return { ok: false, message: error.message };
  }
}

function base64Url(text) {
  const raw = atob(text.replace(/-/g, '+').replace(/_/g, '/'));
  return Uint8Array.from(raw, character => character.charCodeAt(0));
}

function sameKey(left, right) {
  return left.length === right.length && left.every((byte, index) => byte === right[index]);
}
