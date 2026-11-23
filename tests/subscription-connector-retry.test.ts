import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import test from 'node:test';
import {createStore} from '../packages/core/src/store.ts';
import {createConnectorRetry} from '../packages/core/src/subscription-connector-retry.ts';

const now=Date.UTC(2026,0,15);
test('同一连接器第三次失败起退避，次数可跨重启；从一分钟倍增至六小时',t=>{
  t.mock.timers.enable({apis:['Date'],now});
  const dir=mkdtempSync(join(tmpdir(),'super-mario-connector-retry-'));
  const path=join(dir,'test.sqlite');
  let store=createStore(path);
  t.after(()=>{store.close();rmSync(dir,{force:true,recursive:true});});
  let retry=createConnectorRetry(store);
  retry.failed('team.demo.feed');
  retry.failed('team.demo.snapshot');
  assert.equal(retry.get('team.demo.feed'),undefined);
  store.close();
  store=createStore(path);
  retry=createConnectorRetry(store);
  for(const seconds of [60,120,240,480,960,1920,3840,7680,15360,21600,21600]){
    retry.failed('team.demo.feed');
    assert.deepEqual(retry.get('team.demo.snapshot'),{kind:'failures',until:Date.now()+seconds*1000});
    assert.equal(retry.get('team.other.feed'),undefined);
    t.mock.timers.tick(seconds*1000);
    assert.equal(retry.get('team.demo.feed'),undefined);
  }
  retry.succeeded('team.demo.snapshot');
  retry.failed('team.demo.feed');
  assert.equal(retry.get('team.demo.feed'),undefined);
});

test('保留旧版限流截止，选择两者较晚时间；迟到的成功不能解除生效的暂停',t=>{
  t.mock.timers.enable({apis:['Date'],now});
  const store=createStore(':memory:');
  t.after(()=>store.close());
  store.put('source.connector-retry','local',now+45_000);
  const retry=createConnectorRetry(store);
  assert.deepEqual(retry.get('local'),{kind:'rate_limit',until:now+45_000});
  retry.limited('local.feed',now+20_000);
  for(let i=0;i<3;i++) retry.failed('local.feed');
  assert.deepEqual(retry.get('local'),{kind:'failures',until:now+60_000});
  retry.limited('local.snapshot',now+90_000);
  assert.deepEqual(retry.get('local'),{kind:'rate_limit',until:now+90_000});
  retry.succeeded('local.feed');
  retry.limited('local',Infinity);
  assert.deepEqual(retry.get('local'),{kind:'rate_limit',until:now+90_000});
  t.mock.timers.tick(90_000);
  assert.equal(retry.get('local'),undefined);
  retry.failed('local.feed');
  retry.failed('local.snapshot');
  assert.equal(retry.get('local'),undefined);
});
