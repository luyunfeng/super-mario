import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readServerOptions } from '../packages/core/src/config.ts';
import { startServer } from '../apps/server/src/index.ts';

const options = (args: string[] = [], env: NodeJS.ProcessEnv = {}) => readServerOptions(args, env);

test('监听地址接受本机回环、IPv4、IPv6 和主机名，并去掉首尾空白', () => {
  const token = ['--token', 'a-real-token'];
  // Addresses outside the loopback need a token, so they are given one here.
  for (const host of ['127.0.0.1', 'localhost', '::1']) {
    assert.equal(options(['--host', host]).host, host, host);
  }
  for (const host of ['0.0.0.0', '192.0.2.10', '::', 'workbench.internal', 'host-1.example.com']) {
    assert.equal(options(['--host', host, ...token]).host, host, host);
  }
  assert.equal(options(['--host', '  127.0.0.1  ']).host, '127.0.0.1');
  assert.equal(options([], { SUPER_MARIO_HOST: '::1' }).host, '::1');
  assert.equal(options(['--host', '  192.0.2.10  ', ...token]).host, '192.0.2.10');
  // A command-line value wins over the environment, as elsewhere.
  assert.equal(options(['--host', 'localhost'], { SUPER_MARIO_HOST: '::1' }).host, 'localhost');
  assert.equal(options().host, '127.0.0.1', 'the default binds the local machine only');
});

test('监听地址不合法时在启动前拒绝，并说明原因', () => {
  // A label is at most 63 characters, and the whole name at most 253.
  const longLabel = 'a'.repeat(64) + '.example.com';
  const longName = Array.from({ length: 64 }, () => 'abcd').join('.');
  for (const host of ['', '   ', 'not a host', 'host name', 'trailing-', 'a..b', 'a.b.', '.a.b', longLabel, longName, 'host/path', 'user@host', 'host:8080', '[::1]']) {
    assert.throws(() => options(['--host', host]), /监听地址/, JSON.stringify(host));
  }
  // The same name one character shorter is a valid host name, and only needs a token.
  assert.equal(options(['--host', 'a'.repeat(63) + '.example.com', '--token', 'a-real-token']).host, 'a'.repeat(63) + '.example.com');
  // A value that starts with a dash reaches the check when written with an equals sign.
  for (const host of ['-leading', '--other']) {
    assert.throws(() => options(['--host=' + host]), /监听地址/, host);
  }
});

test('端口越界或不是整数时在启动前拒绝；0 表示任意空闲端口', () => {
  assert.equal(options(['--port', '0']).port, 0);
  assert.equal(options(['--port', '65535']).port, 65535);
  for (const port of ['65536', '1.5', 'abc', '', '  ', '0x10', '1e3', '12 34']) {
    assert.throws(() => options(['--port', port]), /端口/, JSON.stringify(port));
  }
  // A value that starts with a dash reaches the check when written with an equals sign.
  assert.throws(() => options(['--port=-1']), /端口/);
  assert.equal(options(['--port', ' 0 ']).port, 0, 'the port is trimmed');
});

test('监听外部地址必须有令牌；全空白的令牌不算令牌', () => {
  for (const host of ['0.0.0.0', '192.0.2.10', '::', 'workbench.internal']) {
    assert.throws(() => options(['--host', host]), /监听外部地址/, host);
    // Spaces are not a token: the check must not be satisfied by one.
    assert.throws(() => options(['--host', host, '--token', '   ']), /监听外部地址/, host);
    assert.throws(() => options(['--host', host], { SUPER_MARIO_TOKEN: ' \t ' }), /监听外部地址/, host);
    assert.equal(options(['--host', host, '--token', '  a-real-token  ']).token, 'a-real-token', 'the token is trimmed and kept');
    assert.equal(options(['--host', host], { SUPER_MARIO_TOKEN: 'a-real-token' }).host, host);
  }
  // On the loopback address a token is optional, and a blank one means none.
  assert.equal(options(['--token', '   ']).token, undefined);
  assert.equal(options().token, undefined);
});

test('全空白的令牌不会被当成令牌：本机仍可免令牌访问，不会被锁在外面', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'mario-blank-token-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  // Before the fix the blank token was kept, which turned off local access while nothing
  // could ever present that exact blank string as a credential.
  const config = readServerOptions(['--demo', '--port', '0', '--data-dir', join(dir, 'data'), '--token', '   '], {});
  const running = await startServer(config);
  try {
    assert.equal(config.token, undefined);
    const page = await fetch(running.url);
    assert.equal(page.status, 200, 'the local page opens without a credential');
    const state = await fetch(running.url + '/api/v1/state');
    assert.equal(state.status, 200, 'the local API answers without a credential');
  } finally { await running.close(); }
});
