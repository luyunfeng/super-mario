import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createIntegrationConfig } from '../packages/core/src/integration-config.ts';

function fixture(t: test.TestContext) {
  const dir = mkdtempSync(join(tmpdir(), 'mario-connector-config-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return { dir, config: createIntegrationConfig(dir) };
}

test('fresh configuration contains no credentials and exposes only public fields', t => {
  const { config } = fixture(t);
  assert.deepEqual(config.read(), { enabled: false, appId: '', appSecret: '' });
  assert.deepEqual(config.public(), { enabled: false, configured: false, appId: '', profile: undefined, collectEnabled: false });
});

test('credentials persist privately with mode 0600 and never appear in public output', t => {
  const { dir, config } = fixture(t);
  config.write({ appId: 'cli_OfflineA', appSecret: 'private-test-secret', profile: 'offline-user' });
  const path = join(dir, 'integrations.json');
  assert.equal(statSync(path).mode & 0o777, 0o600);
  assert.equal(JSON.parse(readFileSync(path, 'utf8')).appSecret, 'private-test-secret');
  assert.deepEqual(createIntegrationConfig(dir).read(), config.read());
  assert.equal(Object.hasOwn(config.public(), 'appSecret'), false);
  assert.ok(!JSON.stringify(config.public()).includes('private-test-secret'));
  config.write({ appSecret: 'replacement-secret' });
  assert.equal(statSync(path).mode & 0o777, 0o600);
  const copy = config.read(); copy.appSecret = 'mutated';
  assert.equal(config.read().appSecret, 'replacement-secret');
});

test('changing appId cannot reuse previous secret, including an explicitly blank secret', t => {
  const { config, dir } = fixture(t);
  config.write({ appId: 'cli_OfflineA', appSecret: 'secret-A' });
  for (const input of [{ appId: 'cli_OfflineB' }, { appId: 'cli_OfflineB', appSecret: ' ' }]) {
    assert.throws(() => config.write(input), /密钥/);
    assert.equal(config.read().appId, 'cli_OfflineA');
    assert.equal(createIntegrationConfig(dir).read().appSecret, 'secret-A');
  }
  config.write({ enabled: false, appId: 'cli_OfflineB' });
  assert.equal(config.read().appSecret, '');
  assert.equal(config.public().configured, false);
});

test('same-app blank secret and partial profile updates preserve existing configuration', t => {
  const { config } = fixture(t);
  config.write({ appId: 'cli_OfflineA', appSecret: 'secret-A', profile: 'user-A' });
  config.write({ appId: ' cli_OfflineA ', appSecret: ' ' });
  assert.equal(config.read().appSecret, 'secret-A');
  assert.equal(config.read().profile, 'user-A');
  config.write({ profile: ' user-B ' });
  assert.deepEqual(config.read(), { enabled: true, appId: 'cli_OfflineA', appSecret: 'secret-A', profile: 'user-B', collectEnabled: false });
  config.write({ enabled: false });
  assert.equal(config.read().profile, 'user-B');
  config.write({ enabled: false, profile: '' });
  assert.equal(config.read().profile, undefined);
});

test('background collection is opt-in, durable, and independently disabled', t => {
  const {config,dir}=fixture(t);
  config.write({appId:'cli_OfflineA',appSecret:'secret-A',profile:'user-A'});
  assert.equal(config.public().collectEnabled,false);
  config.write({collectEnabled:true});assert.equal(createIntegrationConfig(dir).public().collectEnabled,true);
  config.write({collectEnabled:false});assert.equal(createIntegrationConfig(dir).public().collectEnabled,false);
  assert.throws(()=>config.write({collectEnabled:'true'}),/布尔/);
});
