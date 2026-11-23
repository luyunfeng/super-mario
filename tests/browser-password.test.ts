import assert from 'node:assert/strict';
import test from 'node:test';
import * as opaque from '@serenity-kit/opaque';
import {createStore} from '../packages/core/src/store.ts';
import {createBrowserPassword} from '../apps/server/src/browser-password.ts';

const password='synthetic-password-example',admin='fixture-csrf';
function fixture() {
  const store=createStore(':memory:');
  const control={epoch:1,revocations:0,fail:false};
  const devices={
    issuePassword(name:string){store.put('fixture.devices',name,{name});return {name};},
    revokePasswordDevices(){
      for(const {name} of store.list<{name:string}>('fixture.devices'))store.remove('fixture.devices',name);
      if(control.fail)throw new Error('fixture write failure');
      return ()=>{control.revocations++;};
    }
  };
  const open=()=>createBrowserPassword(store,devices,()=>control.epoch);
  return {store,control,open,service:open()};
}
type Service=ReturnType<typeof fixture>['service'];
async function registration(service:Service,pw=password){
  await opaque.ready;
  const request=opaque.client.startRegistration({password:pw});
  const out=await service.registerStart(admin,request.registrationRequest,service.state().revision);
  const finish=opaque.client.finishRegistration({password:pw,clientRegistrationState:request.clientRegistrationState,registrationResponse:out.message});
  return {id:out.session,record:finish.registrationRecord};
}
async function handshake(service:Service,name:string,pw=password){
  await opaque.ready;
  const client=opaque.client.startLogin({password:pw});
  const response=await service.loginStart(name,client.startLoginRequest);
  const finish=opaque.client.finishLogin({password:pw,clientLoginState:client.clientLoginState,loginResponse:response.message});
  return {id:response.session,proof:finish?.finishLoginRequest};
}
test('真实 OPAQUE 配置、换设备、停用和恢复；相同握手只签发一次，密码与协议状态不入库',async t=>{
  const {service,open,control,store}=fixture();t.after(()=>store.close());
  assert.deepEqual(service.state(),{configured:false,enabled:false,revision:'0'});
  assert.throws(()=>service.enable('0',false),{status:409});
  const r=await registration(service);
  assert.throws(()=>service.registerFinish('other',r.id,r.record,false),{status:401});
  const configured=service.registerFinish(admin,r.id,r.record,false);
  const restarted=open(),ok=await handshake(restarted,'浏览器');
  assert.deepEqual(restarted.loginFinish(ok.id,ok.proof!),{name:'浏览器'});
  assert.throws(()=>restarted.loginFinish(ok.id,ok.proof!),{status:401});
  assert.equal((await handshake(restarted,'错误口令','invalid-password')).proof,undefined);
  const stale=await handshake(restarted,'待签发'),disabled=restarted.disable(configured.revision,true);
  assert.equal(disabled.enabled,false);assert.equal(disabled.configured,true);assert.equal(control.revocations,1);assert.deepEqual(store.list('fixture.devices'),[]);
  assert.throws(()=>restarted.enable(configured.revision,false),{status:409});
  assert.throws(()=>restarted.loginFinish(stale.id,stale.proof!),{status:401});
  await assert.rejects(handshake(restarted,'停用时'),{status:403});
  restarted.enable(disabled.revision,false);const again=await handshake(restarted,'恢复后');
  assert.deepEqual(restarted.loginFinish(again.id,again.proof!),{name:'恢复后'});
  const db=JSON.stringify(store.list('core.admin-auth.browser-password'));
  for(const secret of [password,admin,again.id,again.proof!,ok.id])assert.equal(db.includes(secret),false);
});
test('无效记录、插件换代、过期握手均不改配置；撤销事务失败保留设备且不触发断开',async t=>{
  const {service,store,control}=fixture();t.after(()=>store.close());
  let now=Date.now();t.mock.method(Date,'now',()=>now);
  const bad=await registration(service);
  assert.throws(()=>service.registerFinish(admin,bad.id,'A'.repeat(256),false),{status:400});assert.equal(service.state().configured,false);
  const old=await registration(service);control.epoch++;assert.throws(()=>service.registerFinish(admin,old.id,old.record,false),{status:401});
  const r=await registration(service);service.registerFinish(admin,r.id,r.record,false);
  const expired=await handshake(service,'测试');now+=300_000;assert.throws(()=>service.loginFinish(expired.id,expired.proof!),{status:401});
  const fromOldPlugin=await handshake(service,'测试');control.epoch++;assert.throws(()=>service.loginFinish(fromOldPlugin.id,fromOldPlugin.proof!),{status:401});
  const good=await handshake(service,'留下');service.loginFinish(good.id,good.proof!);
  const state=service.state();control.fail=true;
  assert.throws(()=>service.disable(state.revision,true),/fixture write failure/);
  assert.deepEqual(service.state(),state);assert.equal(control.revocations,0);assert.equal(store.list('fixture.devices').length,1);
});
test('第129个未完成握手被限流，配置变更后此前的有效登录证明不能换取设备',async t=>{
  const {service,store}=fixture();t.after(()=>store.close());
  const r=await registration(service);service.registerFinish(admin,r.id,r.record,false);
  const old=await handshake(service,'原请求');
  const start=opaque.client.startLogin({password});
  for(let i=1;i<128;i++)await service.loginStart('未完成',start.startLoginRequest);
  await assert.rejects(service.loginStart('已满',start.startLoginRequest),{status:503});
  service.disable(service.state().revision,false);
  assert.throws(()=>service.loginFinish(old.id,old.proof!),{status:401});
  assert.equal(store.list('fixture.devices').length,0);
});
