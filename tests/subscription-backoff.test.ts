import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import test from 'node:test';
import {createStore} from '../packages/core/src/store.ts';
import {createSourceSubscriptions} from '../packages/core/src/source-subscriptions.ts';

const first='fixture.releases',sibling='fixture.news',other='misc.news';
const sources=()=>[first,sibling,other].map(id=>({id,name:id,resourceLabel:'库'}));
const input=(sourceId:string,resource:string)=>({sourceId,resource,name:resource,intervalMinutes:1,destinations:['inbox','knowledge']});
const limited=(retryAfterSeconds?:unknown)=>Object.assign(new Error('合成上游限流'),{sourceReadCode:'rate_limited',retryAfterSeconds});
const item={id:'new-1',title:'新版本',text:'发布说明'};

test('来源限流跨资源与服务重启，预览、手动和定时共用，另一来源仍正常',async t=>{
  const start=Date.parse('2026-01-02T10:00:00Z');
  t.mock.timers.enable({apis:['Date'],now:start});
  const dir=await mkdtemp(join(tmpdir(),'sm-sub-backoff-')),file=join(dir,'fixture.db');
  let store=createStore(file),unavailable=true;
  const reads:string[]=[];
  function open(){return createSourceSubscriptions({store,sources,
    read:async(sourceId,resource)=>{reads.push(sourceId+':'+resource);
      if(sourceId===first && unavailable)throw limited(180);
      return [item];},deliver(){}});
  }
  let svc=open();t.after(async()=>{await svc.close();store.close();await rm(dir,{recursive:true,force:true});});
  const a=svc.create(input(first,'a')),b=svc.create(input(sibling,'b')),c=svc.create(input(other,'c'));
  await assert.rejects(svc.preview(input(first,'initial')),{status:429});
  unavailable=false;
  await assert.rejects(svc.preview(input(first,'c')),{status:429});
  await assert.rejects(svc.pull(b.id,b.version),{status:429});
  assert.deepEqual(reads,[first+':initial']);
  const paused=svc.update(a.id,{version:a.version,enabled:false});
  const restored=svc.update(a.id,{version:paused.version,enabled:true});
  await svc.close();store.close();store=createStore(file);svc=open();
  t.mock.timers.setTime(start+61000);
  await svc.tick();
  assert.deepEqual(reads,[first+':initial',other+':c']);
  assert.ok(svc.list().find(row=>row.id===c.id)?.lastRunAt);
  await assert.rejects(svc.pull(restored.id,restored.version),{status:429});
  t.mock.timers.setTime(start+179999);
  await assert.rejects(svc.preview(input(first,'b')),{status:429});
  t.mock.timers.setTime(start+180000);
  await svc.pull(b.id,b.version);
  assert.deepEqual(reads,[first+':initial',other+':c',sibling+':b']);
});

test('无效或缺少的等待时长统一退回60秒，预览在截止时间后立即可读',async t=>{
  const start=Date.parse('2026-01-01T00:00:00Z');
  t.mock.timers.enable({apis:['Date'],now:start});
  for(const [index,value] of [undefined,-3,0,Number.NaN,'cab'].entries()){
    // Each fixture represents an independent source provider reporting a malformed retry hint.
    const store=createStore(':memory:');let calls=0;
    const svc=createSourceSubscriptions({store,sources,read:async()=>{if(++calls===1)throw limited(value);return [];},deliver(){}});
    const base=start+index*100000;
    try{
      t.mock.timers.setTime(base);
      const row=svc.create(input(first,'initial'));
      await assert.rejects(svc.pull(row.id,row.version),{status:429});
      t.mock.timers.setTime(base+59999);
      await assert.rejects(svc.preview(input(first,'another')),{status:429});
      assert.equal(calls,1);
      t.mock.timers.setTime(base+60000);await svc.preview(input(first,'another'));assert.equal(calls,2);
    }finally{await svc.close();store.close();}
  }
});

test('冷却期间仍可投递已经保存在 SQLite 的条目，无新远端请求，无重复投递',async t=>{
  const store=createStore(':memory:');
  let knowledgeFails=true,reads=0;
  const delivered:string[]=[];
  const svc=createSourceSubscriptions({store,sources,read:async(_source,resource)=>{
    reads++;if(resource==='other-resource')throw limited(120);return [item];
  },deliver(destination,key){
    if(destination==='knowledge' && knowledgeFails) throw new Error('合成后端断线');
    delivered.push(destination+':'+key);
  }});
  t.after(async()=>{await svc.close();store.close();});
  const row=svc.create(input(first,'saved-here'));
  await assert.rejects(svc.pull(row.id,row.version),{status:502});
  assert.equal(delivered.length,1);
  await assert.rejects(svc.preview(input(first,'other-resource')),{status:429});
  knowledgeFails=false;
  await assert.rejects(svc.pull(row.id,row.version),{status:429});
  assert.deepEqual(delivered.map(s=>s.split(':')[0]),['inbox','knowledge']);
  await assert.rejects(svc.pull(row.id,row.version),{status:429});
  assert.equal(reads,2);assert.equal(delivered.length,2);
});

test('同插件并发读取至多一份已出站，首个返回限流后其它读取受到同一冷却保护',async t=>{
  const store=createStore(':memory:');
  let begin!:()=>void,unblock!:()=>void;
  const started=new Promise<void>(r=>{begin=r;}),gate=new Promise<void>(r=>{unblock=r;});
  let active=0,peak=0,requests=0;
  const svc=createSourceSubscriptions({store,sources,read:async()=>{
    requests++;active++;peak=Math.max(peak,active);begin();
    try{await gate;throw limited(90);}finally{active--;}
  },deliver(){}});
  t.after(async()=>{unblock();await svc.close();store.close();});
  const a=svc.create(input(first,'r1')),b=svc.create(input(sibling,'r2'));
  const firstRead=assert.rejects(svc.pull(a.id,1),{status:429});
  await started;
  const otherCalls=Promise.allSettled([svc.pull(b.id,1),svc.preview(input(first,'r3')),svc.preview(input(sibling,'r4'))]);
  await new Promise<void>(resolve=>setImmediate(resolve));
  try { assert.equal(peak,1); } finally { unblock(); }
  await firstRead;
  const results=await otherCalls;
  assert.ok(results.every(result=>result.status==='rejected'));
  assert.equal(requests,1);
  await assert.rejects(svc.preview(input(sibling,'r5')),{status:429});
  assert.equal(requests,1);
});

test('等待另一资源的预览可以立即取消，不发起第二次读取',async t=>{
  const store=createStore(':memory:');
  let release!:()=>void,reads=0;
  const wait=new Promise<void>(resolve=>{release=resolve;});
  const svc=createSourceSubscriptions({store,sources,async read(){reads++;await wait;return [];},deliver(){}});
  t.after(async()=>{release();await svc.close();store.close();});
  const firstRead=svc.preview(input(first,'in-flight'));
  const controller=new AbortController();
  const queued=svc.preview(input(sibling,'queued'),controller.signal);
  controller.abort();
  await assert.rejects(queued,{name:'AbortError'});
  assert.equal(reads,1);
  release();await firstRead;
});
