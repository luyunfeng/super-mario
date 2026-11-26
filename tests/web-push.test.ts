import assert from 'node:assert/strict';
import { createDecipheriv, createECDH, createPublicKey, createVerify, hkdfSync } from 'node:crypto';
import { createServer } from 'node:http';
import test from 'node:test';
import { encryptPush, MAX_PLAINTEXT, newVapidKeys, postPush, pushTopic, readVapidKeys, subscriptionGone, validSubscriptionKeys, vapidAuthorization, type PushSubscription, type VapidKeys } from '../packages/core/src/web-push.ts';

// The browser's side of RFC 8291, written here to check the sender's: it reads the header, works
// out the same keys from its own private key, and decrypts the one record.
function browserDecrypt(browser: ReturnType<typeof createECDH>, auth: Buffer, message: Buffer): Buffer {
  const salt = message.subarray(0, 16);
  const recordSize = message.readUInt32BE(16);
  const idLength = message[20]!;
  const senderPublic = message.subarray(21, 21 + idLength);
  const header = message.subarray(0, 21 + idLength);
  const ciphertext = message.subarray(21 + idLength);
  const ecdhSecret = browser.computeSecret(senderPublic);
  const ikm = Buffer.from(hkdfSync('sha256', ecdhSecret, auth, Buffer.concat([Buffer.from('WebPush: info\0'), browser.getPublicKey(), senderPublic]), 32));
  const cek = Buffer.from(hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: aes128gcm\0'), 16));
  const nonce = Buffer.from(hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: nonce\0'), 12));
  const decipher = createDecipheriv('aes-128-gcm', cek, nonce);
  decipher.setAAD(header);
  // The last 16 bytes are the authentication tag; it is given to the decipher before it is checked.
  decipher.setAuthTag(ciphertext.subarray(ciphertext.length - 16));
  const plaintext = Buffer.concat([decipher.update(ciphertext.subarray(0, ciphertext.length - 16)), decipher.final()]);
  // The last byte is the delimiter: 2 says no padding follows it.
  assert.equal(plaintext.at(-1), 2);
  assert.ok(recordSize >= plaintext.length + 16);
  return plaintext.subarray(0, -1);
}

function subscription(): { subscription: PushSubscription; browser: ReturnType<typeof createECDH>; auth: Buffer } {
  const browser = createECDH('prime256v1');
  browser.generateKeys();
  const auth = Buffer.from(Array.from({ length: 16 }, (_, i) => i + 1));
  return { subscription: { endpoint: 'https://push.example.invalid/push/one', p256dh: browser.getPublicKey().toString('base64url'), auth: auth.toString('base64url') }, browser, auth };
}

test('a push is encrypted so that only the subscribing browser can read it', () => {
  const { subscription: sub, browser, auth } = subscription();
  const plaintext = Buffer.from(JSON.stringify({ title: '需要你决定', body: '合成的通知内容' }));
  const sent = encryptPush(sub, plaintext);
  assert.deepEqual(sent.headers, { 'Content-Encoding': 'aes128gcm', 'Content-Type': 'application/octet-stream' });
  assert.deepEqual(browserDecrypt(browser, auth, sent.body), plaintext);
  // The push service sees ciphertext: the words are not in what it carries.
  assert.equal(sent.body.includes(plaintext), false);
  // Another browser cannot read it: its ECDH secret with the sender differs.
  const other = createECDH('prime256v1');
  other.generateKeys();
  assert.throws(() => browserDecrypt(other, auth, sent.body));
  // Each message has its own sender key and salt.
  const again = encryptPush(sub, plaintext);
  assert.notDeepEqual(sent.body.subarray(0, 21), again.body.subarray(0, 21));
});

test('keys a browser would not give are refused before anything is encrypted', () => {
  const { subscription: sub } = subscription();
  assert.throws(() => encryptPush({ ...sub, p256dh: Buffer.alloc(64).toString('base64url') }, Buffer.from('x')), /invalid subscription keys/);
  assert.throws(() => encryptPush({ ...sub, auth: Buffer.alloc(8).toString('base64url') }, Buffer.from('x')), /invalid subscription keys/);
  assert.equal(validSubscriptionKeys(sub), true);
  assert.equal(validSubscriptionKeys({ ...sub, p256dh: 'not base64!' }), false);
  // 65 bytes starting with 4, but not a point on the curve.
  assert.equal(validSubscriptionKeys({ ...sub, p256dh: Buffer.concat([Buffer.from([4]), Buffer.alloc(64)]).toString('base64url') }), false);
});

test('the largest message fits and is read back whole; one byte more is refused before it is sent', () => {
  const { subscription: sub, browser, auth } = subscription();
  const largest = Buffer.alloc(MAX_PLAINTEXT, 0x41);
  assert.deepEqual(browserDecrypt(browser, auth, encryptPush(sub, largest).body), largest);
  assert.throws(() => encryptPush(sub, Buffer.alloc(MAX_PLAINTEXT + 1)), /too large/);
});

test('a VAPID key pair is made, read back, and its signature is verified with its public half', () => {
  const keys = newVapidKeys();
  assert.deepEqual(readVapidKeys(keys), keys);
  assert.equal(readVapidKeys({ ...keys, public: newVapidKeys().public }), undefined);
  assert.equal(readVapidKeys({ ...keys, private: 'short' }), undefined);
  assert.equal(readVapidKeys('a string'), undefined);
  const authorization = vapidAuthorization('https://push.example.invalid/push/one', 'mailto:owner@example.invalid', keys, new Date('2026-11-27T00:00:00Z'));
  const match = /^vapid t=([^.]+)\.([^.]+)\.([^,]+), k=(.+)$/.exec(authorization);
  assert.ok(match);
  assert.deepEqual(JSON.parse(Buffer.from(match[1]!, 'base64url').toString()), { typ: 'JWT', alg: 'ES256' });
  assert.deepEqual(JSON.parse(Buffer.from(match[2]!, 'base64url').toString()), { aud: 'https://push.example.invalid', exp: Date.parse('2026-11-27T12:00:00Z') / 1000, sub: 'mailto:owner@example.invalid' });
  const point = Buffer.from(keys.public, 'base64url');
  const publicJwk = { kty: 'EC', crv: 'P-256', x: point.subarray(1, 33).toString('base64url'), y: point.subarray(33, 65).toString('base64url') };
  const verifier = createVerify('SHA256').update(match[1] + '.' + match[2]);
  assert.equal(verifier.verify({ key: createPublicKey({ format: 'jwk', key: publicJwk }), dsaEncoding: 'ieee-p1363' }, Buffer.from(match[3]!, 'base64url')), true);
  assert.equal(match[4], keys.public);
  assert.throws(() => vapidAuthorization('https://push.example.invalid/x', 's', { private: 'bad', public: keys.public } as VapidKeys, new Date()), /invalid VAPID key/);
});

test('a topic is a short base64url string, the same for the same tag and absent for none', () => {
  const topic = pushTopic('card:abc#needs');
  assert.equal(topic, pushTopic('card:abc#needs'));
  assert.match(topic!, /^[A-Za-z0-9_-]{1,32}$/);
  assert.notEqual(topic, pushTopic('card:def#needs'));
  assert.equal(pushTopic(undefined), undefined);
  assert.equal(pushTopic(''), undefined);
});

test('a push is posted to its endpoint with the headers a push service reads, and the answer is given back', async () => {
  const { subscription: sub } = subscription();
  const keys = newVapidKeys();
  let received: { headers: Record<string, string | string[] | undefined>; body: Buffer; url: string } | undefined;
  const service = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', chunk => chunks.push(chunk as Buffer));
    req.on('end', () => {
      received = { headers: req.headers, body: Buffer.concat(chunks), url: req.url! };
      res.writeHead(201).end('created');
    });
  });
  await new Promise<void>(resolve => service.listen(0, '127.0.0.1', resolve));
  const port = (service.address() as { port: number }).port;
  const endpoint = 'http://127.0.0.1:' + port + '/push/one';
  const encrypted = encryptPush(sub, Buffer.from('hello'));
  const answer = await postPush(endpoint, { ttl: 60, urgency: 'high', topic: pushTopic('card:abc#needs') }, encrypted, vapidAuthorization(endpoint, 'mailto:owner@example.invalid', keys));
  await new Promise<void>((resolve, reject) => service.close(error => error ? reject(error) : resolve()));
  assert.deepEqual(answer, { status: 201, body: 'created' });
  assert.equal(received!.url, '/push/one');
  assert.equal(received!.headers['content-encoding'], 'aes128gcm');
  assert.equal(received!.headers['content-type'], 'application/octet-stream');
  assert.equal(received!.headers['ttl'], '60');
  assert.equal(received!.headers['urgency'], 'high');
  assert.match(String(received!.headers['authorization']), /^vapid t=/);
  assert.deepEqual(received!.body, encrypted.body);
  // A service that cannot be reached is status 0, and is not "the subscription is gone".
  const unreachable = await postPush('http://127.0.0.1:1/push/one', { ttl: 60, urgency: 'normal' }, encrypted, 'vapid t=x', fetch);
  assert.equal(unreachable.status, 0);
  assert.ok(unreachable.networkError);
  assert.equal(subscriptionGone(unreachable), false);
  assert.equal(subscriptionGone({ status: 410, body: '' }), true);
  assert.equal(subscriptionGone({ status: 404, body: '' }), true);
  assert.equal(subscriptionGone({ status: 201, body: '' }), false);
  // A service that never answers is given up on; it is not left hanging.
  const slow = createServer(() => {});
  await new Promise<void>(resolve => slow.listen(0, '127.0.0.1', () => resolve()));
  const slowPort = (slow.address() as { port: number }).port;
  const timedOut = await postPush('http://127.0.0.1:' + slowPort + '/push/one', { ttl: 60, urgency: 'normal' }, encrypted, 'vapid t=x', fetch, 200);
  assert.equal(timedOut.status, 0);
  assert.match(timedOut.networkError!, /timeout|aborted/i);
  slow.closeAllConnections();
  await new Promise<void>((resolve, reject) => slow.close(error => error ? reject(error) : resolve()));
});
