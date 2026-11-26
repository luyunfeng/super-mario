// Web Push: RFC 8030 delivery, RFC 8291 message encryption (aes128gcm) and RFC 8292 VAPID, with the
// standard library only. This file knows nothing of the workbench: what to send and to whom is
// the workbench's (web-push-subscriptions.ts).
import { createCipheriv, createECDH, createHash, createPrivateKey, createSign, hkdfSync, randomBytes } from 'node:crypto';

const b64 = (bytes: Uint8Array) => Buffer.from(bytes).toString('base64url');
const unb64 = (text: string) => Buffer.from(text, 'base64url');

/** A VAPID key pair (RFC 8292). Public is what the browser takes as applicationServerKey. */
export interface VapidKeys { private: string; public: string }

/** A new P-256 key pair. */
export function newVapidKeys(): VapidKeys {
  const curve = createECDH('prime256v1');
  curve.generateKeys();
  return { private: b64(curve.getPrivateKey()), public: b64(curve.getPublicKey()) };
}

/** The public half that belongs to a raw P-256 private scalar, or undefined when it is not one. */
function publicOf(privateKey: string): Buffer | undefined {
  try {
    const raw = unb64(privateKey);
    if (raw.length !== 32) return undefined;
    const curve = createECDH('prime256v1');
    curve.setPrivateKey(raw);
    return curve.getPublicKey();
  } catch { return undefined; }
}

/** A key pair read back from storage. Undefined when it is not a usable pair. */
export function readVapidKeys(value: unknown): VapidKeys | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const { private: privateKey, public: publicKey } = value as Record<string, unknown>;
  if (typeof privateKey !== 'string' || typeof publicKey !== 'string') return undefined;
  return b64(publicOf(privateKey) ?? Buffer.alloc(0)) === publicKey ? { private: privateKey, public: publicKey } : undefined;
}

/** A browser's PushSubscription, as its toJSON() gives it. */
export interface PushSubscription { endpoint: string; p256dh: string; auth: string }

/** Whether the subscription's keys are what a browser gives: an uncompressed P-256 point that is
 *  on the curve, and a 16-byte secret. */
export function validSubscriptionKeys(subscription: PushSubscription): boolean {
  try {
    const uaPublic = unb64(subscription.p256dh), authSecret = unb64(subscription.auth);
    if (uaPublic.length !== 65 || uaPublic[0] !== 4 || authSecret.length !== 16) return false;
    // A point that is not on the curve is refused by the ECDH itself; asking is the shortest check.
    // The ECDH needs a private key of its own to ask with, so one is made for the check and dropped.
    const check = createECDH('prime256v1');
    check.generateKeys();
    check.computeSecret(uaPublic);
    return true;
  } catch { return false; }
}

/** How the push service may treat a push. */
export interface PushMessage {
  /** How long the push service keeps it for a browser that is away, in seconds. */
  ttl: number;
  /** Something waiting on the user goes at once, even to a browser saving battery. */
  urgency: 'very-low' | 'low' | 'normal' | 'high';
  /** Pushes with one topic replace each other at the push service, as notifications with one tag do. */
  topic?: string;
}

/** What goes to the push service: the POST's body and its Content-* headers. */
export interface EncryptedPush { body: Buffer; headers: Record<string, string> }

/** The most plaintext one push carries. A push service takes 4096 bytes of record; the header,
 *  the delimiter and the tag take 86 of them, and a message that does not fit is refused here
 *  rather than by the service. */
export const MAX_PLAINTEXT = 4000;

/**
 * The payload encrypted to the subscription's keys (RFC 8291). Only the browser can read it: its
 * push service carries ciphertext.
 *
 *   1. A sender key pair is made fresh. The ECDH secret is ECDH(sender private, browser public).
 *   2. IKM = HKDF(salt = the browser's auth secret, ikm = the ECDH secret,
 *                info = "WebPush: info\0" || browser public || sender public, L = 32).
 *   3. A random 16-byte salt. CEK = HKDF(salt, IKM, "Content-Encoding: aes128gcm\0", 16) and
 *      NONCE = HKDF(salt, IKM, "Content-Encoding: nonce\0", 12).
 *   4. The one record is AES-128-GCM(CEK, NONCE, plaintext || 0x02, the header as additional data).
 */
export function encryptPush(subscription: PushSubscription, plaintext: Uint8Array): EncryptedPush {
  if (!validSubscriptionKeys(subscription)) throw new Error('invalid subscription keys');
  if (plaintext.length > MAX_PLAINTEXT) throw new Error('plaintext too large for one push');
  const uaPublic = unb64(subscription.p256dh), authSecret = unb64(subscription.auth);
  const sender = createECDH('prime256v1');
  sender.generateKeys();
  const senderPublic = sender.getPublicKey();
  const ecdhSecret = sender.computeSecret(uaPublic);
  const keyInfo = Buffer.concat([Buffer.from('WebPush: info\0'), uaPublic, senderPublic]);
  const ikm = Buffer.from(hkdfSync('sha256', ecdhSecret, authSecret, keyInfo, 32));
  const salt = randomBytes(16);
  const cek = Buffer.from(hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: aes128gcm\0'), 16));
  const nonce = Buffer.from(hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: nonce\0'), 12));
  // One record of 4096 bytes, the most every push service has to take. It covers the plaintext,
  // the delimiter and the 16-byte tag because the plaintext was limited to MAX_PLAINTEXT above.
  const recordSize = 4096;
  // The header: salt (16) | rs (4) | idlen (1) | the sender's public key.
  const header = Buffer.concat([salt, Buffer.from([recordSize >>> 24 & 255, recordSize >>> 16 & 255, recordSize >>> 8 & 255, recordSize & 255]),
    Buffer.from([senderPublic.length]), senderPublic]);
  const cipher = createCipheriv('aes-128-gcm', cek, nonce);
  cipher.setAAD(header);
  // 0x02 is the delimiter of the last record: it says where the padding ends.
  const ciphertext = Buffer.concat([cipher.update(Buffer.concat([Buffer.from(plaintext), Buffer.from([2])])), cipher.final(), cipher.getAuthTag()]);
  return { body: Buffer.concat([header, ciphertext]), headers: { 'Content-Encoding': 'aes128gcm', 'Content-Type': 'application/octet-stream' } };
}

/** The signer's key, from the raw private scalar. The JWK also needs the public point, which the curve gives. */
function signingKey(keys: VapidKeys) {
  const scalar = unb64(keys.private), point = publicOf(keys.private);
  if (!point) throw new Error('invalid VAPID key');
  return createPrivateKey({ format: 'jwk', key: { kty: 'EC', crv: 'P-256', d: b64(scalar), x: b64(point.subarray(1, 33)), y: b64(point.subarray(33, 65)) } });
}

/** The VAPID Authorization header (RFC 8292 section 3) for a push to endpoint. The token lives 12 hours. */
export function vapidAuthorization(endpoint: string, subject: string, keys: VapidKeys, now = new Date()): string {
  const origin = new URL(endpoint).origin;
  const encode = (value: unknown) => b64(Buffer.from(JSON.stringify(value)));
  const signing = encode({ typ: 'JWT', alg: 'ES256' }) + '.'
    + encode({ aud: origin, exp: Math.floor(now.getTime() / 1000) + 12 * 60 * 60, sub: subject });
  // ES256 signs with raw r and s, each 32 bytes (ieee-p1363), as the RFC requires.
  const signature = createSign('SHA256').update(signing).sign({ key: signingKey(keys), dsaEncoding: 'ieee-p1363' });
  return 'vapid t=' + signing + '.' + b64(signature) + ', k=' + keys.public;
}

/** The Topic header: at most 32 base64url characters, so a long tag is hashed to fit. */
export function pushTopic(tag: string | undefined): string | undefined {
  return tag ? createHash('sha256').update(tag).digest('base64url').slice(0, 32) : undefined;
}

/** What a push service answered. Status 0 is that it could not be reached at all. */
export interface PushAnswer { status: number; body: string; networkError?: string }

/** How long one POST to a push service may take before it is given up. */
export const PUSH_TIMEOUT_MS = 15000;

/** Posts one push to its push service. It does not try again: the caller decides what is worth another try. */
export async function postPush(endpoint: string, message: PushMessage, encrypted: EncryptedPush, authorization: string, fetchImpl: typeof fetch = fetch, timeoutMs = PUSH_TIMEOUT_MS): Promise<PushAnswer> {
  try {
    const response = await fetchImpl(endpoint, { method: 'POST', signal: AbortSignal.timeout(timeoutMs), headers: {
      ...encrypted.headers, TTL: String(message.ttl), Urgency: message.urgency, ...(message.topic ? { Topic: message.topic } : {}), Authorization: authorization },
      body: new Uint8Array(encrypted.body) });
    return { status: response.status, body: (await response.text()).slice(0, 500) };
  } catch (error) {
    return { status: 0, body: '', networkError: error instanceof Error ? error.message : String(error) };
  }
}

/** The push service says the subscription is no more (RFC 8030): the browser must subscribe again. */
export function subscriptionGone(answer: PushAnswer): boolean {
  return answer.status === 404 || answer.status === 410;
}
