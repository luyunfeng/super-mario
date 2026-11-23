import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {createHash} from 'node:crypto';
import {createStore} from '../packages/core/src/store.ts';
import {createEventBus} from '../packages/core/src/events.ts';
import {createContributions,PluginHost} from '../packages/core/src/plugin-host.ts';
import {createBrowserDevices} from '../plugins/browser-devices.ts';

function replaces(receipt:{token:string; device:{id:string}}) {
  const hash=(s:string)=>createHash('sha256').update(s).digest('hex');
  return {id:receipt.device.id,proof:hash('super-mario.browser-replace.v1:'+hash(receipt.token))};
}
async function open(dir:string) {
  const store=createStore(join(dir,'db.sqlite')),invalidations:(string|undefined)[]=[];
  const browser=createBrowserDevices(store,id=>invalidations.push(id));
  const host=new PluginHost({dataDir:dir,store,contributions:createContributions(),events:createEventBus(store)});
  host.register(browser.extension);
  await host.start();
  return {browser,host,invalidations,close:async()=>{await host.close();store.close();}};
}
test('配对码单次原子消费，凭证持久化仅含摘要，重启后仍可独立撤销',async t=>{
  const dir=await mkdtemp(join(tmpdir(),'browser-devices-'));
  t.after(()=>rm(dir,{recursive:true,force:true}));
  let ctx=await open(dir); t.after(()=>ctx.close());
  const issue=ctx.browser.issue('浏览器甲'),first=ctx.browser.redeem(issue.code);
  assert.equal(ctx.browser.authenticate(first.token),first.device.id);
  assert.throws(()=>ctx.browser.redeem(issue.code),{status:401});
  const second=ctx.browser.redeem(ctx.browser.issue('浏览器乙').code);
  const unused=ctx.browser.issue('未连接');
  assert.deepEqual(ctx.browser.list().map(d=>d.name).sort(),['浏览器乙','浏览器甲'].sort());
  const db=new DatabaseSync(join(dir,'db.sqlite'),{readOnly:true});
  try {
    const documents=JSON.stringify(db.prepare('SELECT id,value FROM documents').all());
    for(const secret of [first.token,second.token,first.replacementProof,second.replacementProof,issue.code,unused.code]) assert.ok(!documents.includes(secret));
  } finally { db.close(); }
  await ctx.close();ctx=await open(dir);
  assert.equal(ctx.browser.authenticate(first.token),first.device.id);
  assert.throws(()=>ctx.browser.redeem(unused.code),{status:401});
  assert.equal(ctx.browser.revoke(first.device.id),true);assert.deepEqual(ctx.invalidations,[first.device.id]);
  assert.equal(ctx.browser.authenticate(first.token),undefined);
  assert.equal(ctx.browser.revoke(first.device.id),false);
  assert.equal(ctx.browser.authenticate(second.token),second.device.id);
  assert.deepEqual(Object.keys(ctx.browser.list()[0]!).sort(),['createdAt','id','lastSeenAt','name']);
});
test('过期或停用的配对码无法再用；停用关闭全部设备连接，启用后恢复已有授权',async t=>{
  const dir=await mkdtemp(join(tmpdir(),'browser-device-expiry-'));
  t.after(()=>rm(dir,{recursive:true,force:true}));
  const ctx=await open(dir);t.after(()=>ctx.close());
  let now=Date.now();t.mock.method(Date,'now',()=>now);
  const expired=ctx.browser.issue('过期设备');now=Date.parse(expired.expiresAt);
  assert.throws(()=>ctx.browser.redeem(expired.code),{status:401});
  const bound=ctx.browser.redeem(ctx.browser.issue('已绑定').code);
  const old=ctx.browser.issue('未配对');
  await ctx.host.setEnabled('browser-devices',false);
  assert.deepEqual(ctx.invalidations,[undefined]);
  assert.equal(ctx.browser.authenticate(bound.token),undefined);
  for(const action of [()=>ctx.browser.issue('设备'),()=>ctx.browser.list(),()=>ctx.browser.redeem(old.code),()=>ctx.browser.revoke(bound.device.id)])
    assert.throws(action,{status:503});
  await ctx.host.setEnabled('browser-devices',true);
  assert.throws(()=>ctx.browser.redeem(old.code),{status:401});
  assert.equal(ctx.browser.authenticate(bound.token),bound.device.id);
  assert.equal(ctx.browser.authenticate('invented'),undefined);
  assert.throws(()=>ctx.browser.issue(' '),{status:400});
});
test('注册设备落库失败时，配对码消费一起回滚',async t=>{
  const dir=await mkdtemp(join(tmpdir(),'browser-device-rollback-'));
  t.after(()=>rm(dir,{recursive:true,force:true}));
  const ctx=await open(dir);t.after(()=>ctx.close());
  const original=ctx.browser.redeem(ctx.browser.issue('原设备').code);
  const replacement=replaces(original),{code}=ctx.browser.issue('等待配对');
  const db=new DatabaseSync(join(dir,'db.sqlite'));
  try {
    db.exec("CREATE TRIGGER break_device BEFORE INSERT ON documents WHEN NEW.collection='browser-devices.credentials' BEGIN SELECT RAISE(ABORT,'fixture'); END;");
    assert.throws(()=>ctx.browser.redeem(code,replacement),/fixture/);
    assert.equal(ctx.browser.authenticate(original.token),original.device.id);
    assert.deepEqual(ctx.invalidations,[]);
    db.exec('DROP TRIGGER break_device');
    const {token,device}=ctx.browser.redeem(code,replacement);
    assert.equal(ctx.browser.authenticate(token),device.id);
    assert.deepEqual(ctx.invalidations,[original.device.id]);
    assert.equal(ctx.browser.authenticate(original.token),undefined);
  } finally {db.close();}
});
test('有效配对码与对应旧凭据的替换证明合用才撤销；证明无法登录或冒充其他设备',async t=>{
  const dir=await mkdtemp(join(tmpdir(),'browser-device-replace-'));
  t.after(()=>rm(dir,{recursive:true,force:true}));
  const ctx=await open(dir);t.after(()=>ctx.close());
  const pair=(name:string)=>ctx.browser.redeem(ctx.browser.issue(name).code);
  const first=pair('原设备'),other=pair('其他设备'),replace=replaces(first);
  assert.equal(first.replacementProof,replace.proof);
  assert.equal(ctx.browser.authenticate(replace.proof),undefined);
  assert.throws(()=>ctx.browser.redeem('invalid',replace),{status:401});
  const wrong=ctx.browser.redeem(ctx.browser.issue('新设备').code,{...replace,id:other.device.id});
  assert.equal(ctx.browser.authenticate(wrong.token),wrong.device.id);
  assert.equal(ctx.browser.authenticate(other.token),other.device.id);
  assert.equal(ctx.browser.authenticate(first.token),first.device.id);
  assert.deepEqual(ctx.invalidations,[]);
  const paired=ctx.browser.redeem(ctx.browser.issue('重新连接').code,replace);
  assert.equal(ctx.browser.authenticate(paired.token),paired.device.id);
  assert.equal(ctx.browser.authenticate(first.token),undefined);
  assert.deepEqual(ctx.invalidations,[first.device.id]);
  const another=ctx.browser.redeem(ctx.browser.issue('旧证已无效').code,replace);
  assert.equal(ctx.browser.authenticate(another.token),another.device.id);
  assert.deepEqual(ctx.invalidations,[first.device.id]);
});
