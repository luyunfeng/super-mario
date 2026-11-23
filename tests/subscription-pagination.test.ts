import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import test from 'node:test';
import {createStore} from '../packages/core/src/store.ts';
import {createSourceSubscriptions} from '../packages/core/src/source-subscriptions.ts';

const source={id:'page.example',name:'分页来源',resourceLabel:'资源'};
const input={sourceId:source.id,resource:'example',name:'测试',intervalMinutes:8,destinations:['inbox']};
const item=(id:string)=>({id,title:id,text:'测试'});
type Options=Parameters<typeof createSourceSubscriptions>[0];

test('跨重启逐页拉取，部分投递从 SQLite 补齐，整轮成功前不推进水位',async t=>{
  const dir=await mkdtemp(join(tmpdir(),'sm-page-')),path=join(dir,'fixture.db');
  let store=createStore(path),round=0,failDelivery=false;
  const reads:{cursor?:string;checkpoint?:string}[]=[],done:string[]=[];
  const secret='private-position-111',mark='private-watermark-111';
  const read:Options['read']=async(_id,_resource,_signal,cursor,checkpoint)=>{
    reads.push({cursor,checkpoint});
    if(round===0) return {items:[item('first')],checkpoint:mark};
    if(cursor) return {items:[item('new2')],checkpoint:'ignored-later-mark'};
    return {items:[item('new1')],nextCursor:secret,checkpoint:round===2 ? 'private-watermark-uncommitted' : mark+'-next'};
  };
  function open(){return createSourceSubscriptions({store,sources:()=>[source],read,deliver(_dest,_key,value){
    if(failDelivery && value.id==='new2') throw new Error('合成失败');done.push(value.id);
  }});}
  let svc=open();t.after(async()=>{await svc.close();store.close();await rm(dir,{recursive:true,force:true});});
  const row=svc.create(input);
  await svc.pull(row.id,1);
  round=1;
  const preview=await svc.preview(input);assert.deepEqual(preview,{items:[item('new1')],hasMore:true});
  assert.deepEqual(reads.at(-1),{cursor:undefined,checkpoint:undefined});
  const next=await svc.pull(row.id,1);assert.equal(next.nextPageNumber,2);assert.ok(Date.parse(next.nextRunAt)<=Date.now());
  assert.deepEqual(reads.at(-1),{cursor:undefined,checkpoint:mark});
  assert.doesNotMatch(JSON.stringify([next,svc.list()]),/private-/);
  await svc.close();store.close();store=createStore(path);svc=open();
  failDelivery=true;await assert.rejects(svc.pull(row.id,1),{status:502});
  assert.deepEqual(reads.at(-1),{cursor:secret,checkpoint:mark});
  const before=reads.length;
  await svc.close();store.close();store=createStore(path);svc=open();
  failDelivery=false;
  const terminal=await svc.pull(row.id,1);
  assert.equal(terminal.nextPageNumber,undefined);assert.equal(reads.length,before);
  assert.ok(Date.parse(terminal.nextRunAt)>Date.now());assert.deepEqual(done,['first','new1','new2']);
  round=2;
  await svc.pull(row.id,1);assert.deepEqual(reads.at(-1),{cursor:undefined,checkpoint:mark+'-next'});
  assert.deepEqual(done,['first','new1','new2']);
  const disabled=svc.update(row.id,{version:1,enabled:false});
  const resumed=svc.update(row.id,{version:disabled.version,enabled:true});
  await svc.pull(row.id,resumed.version);
  assert.deepEqual(reads.at(-1),{cursor:undefined,checkpoint:mark+'-next'});
  const extra=svc.update(row.id,{version:resumed.version,destinations:['inbox','knowledge']});
  await svc.pull(row.id,extra.version);assert.deepEqual(reads.at(-1),{cursor:undefined,checkpoint:undefined});
});

test('不通或限流保留续点，连续两次普通错误退回首页',async t=>{
  t.mock.timers.enable({apis:['Date'],now:Date.now()});
  const store=createStore(':memory:');let code='',count=0;
  const cursors:(string|undefined)[]=[];
  const svc=createSourceSubscriptions({store,sources:()=>[source],deliver(){},async read(_id,_r,_s,cursor){
    cursors.push(cursor);if(code)throw Object.assign(new Error('synthetic'),{sourceReadCode:code,retryAfterSeconds:1});
    return {items:[],nextCursor:'pos'+ ++count};
  }});
  t.after(async()=>{await svc.close();store.close();});
  const row=svc.create(input);await svc.pull(row.id,1);
  for(const [failure,status] of [['unavailable',503],['rate_limited',429],['error',502],['error',502]] as const){
    code=failure;await assert.rejects(svc.pull(row.id,1),{status});t.mock.timers.tick(1100);
  }
  assert.equal(svc.list()[0]!.nextPageNumber,undefined);
  code='';await svc.pull(row.id,1);assert.deepEqual(cursors,[undefined,'pos1','pos1','pos1','pos1',undefined]);
});

test('拒绝无效、重复与越过100页的游标，停用后不会继续调度',async t=>{
  for(const mode of ['invalid','oversize','cycle','overflow','exactly100']){
    const store=createStore(':memory:');let calls=0;
    const svc=createSourceSubscriptions({store,sources:()=>[source],deliver(){},async read(){
      calls++;
      let nextCursor:string|undefined='token'+calls;
      if(mode==='invalid')nextCursor=42 as unknown as string;
      if(mode==='oversize')nextCursor='界'.repeat(683);
      if(mode==='cycle' && calls===3)nextCursor='token1';
      if(mode==='exactly100' && calls===100)nextCursor=undefined;
      return {items:[],nextCursor};
    }});
    try {
      const row=svc.create(input);
      const pages=mode==='overflow' || mode==='exactly100' ? 100 : mode==='cycle' ? 3 : 1;
      for(let n=1;n<pages;n++)await svc.pull(row.id,1);
      if(mode==='exactly100'){
        const last=await svc.pull(row.id,1);assert.equal(last.nextPageNumber,undefined);assert.equal(last.enabled,true);
      }else{
        await assert.rejects(svc.pull(row.id,1),{status:502});
        const failed=svc.list()[0]!;assert.equal(failed.enabled,false);assert.ok(failed.error);
        assert.doesNotMatch(JSON.stringify(failed),/token1/);
        await svc.tick();assert.equal(calls,pages);
      }
    } finally {await svc.close();store.close();}
  }
});
