import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import test from 'node:test';
import {createStore} from '../packages/core/src/store.ts';
import {createSourceSubscriptions} from '../packages/core/src/source-subscriptions.ts';

const src={id:'local.feed',name:'合成',resourceLabel:'资源'};
const input={sourceId:src.id,resource:'fixture',name:'测试运行',destinations:['inbox','knowledge'],intervalMinutes:1};
const rowItem=(i:number)=>({id:String(i),title:'条目 '+i+' https://secret.invalid/title',text:'敏感正文',
  url:'https://secret.invalid/item'});

test('运行历史只列已受理拉取；当前页目标失败与跨重启补投各计其实际回执',async t=>{
  const dir=await mkdtemp(join(tmpdir(),'sm-sub-runs-')),path=join(dir,'test.db');
  let store=createStore(path),failed=true;
  function open(){return createSourceSubscriptions({store,sources:()=>[src],
    read:async(_s,_r,_sig,cursor)=>cursor ? {items:[]} : {items:Array.from({length:12},(_,i)=>rowItem(i)),nextCursor:'secret-cursor'},
    deliver:(d)=>{if(failed && d==='knowledge')throw new Error('内部秘密');}
  });}
  let svc=open();t.after(async()=>{await svc.close();store.close();await rm(dir,{recursive:true,force:true});});
  const row=svc.create(input);await svc.preview(input);await assert.rejects(svc.pull(row.id,99),{status:409});
  assert.deepEqual(svc.runHistory(row.id).items,[]);
  await assert.rejects(svc.pull(row.id,1),{status:502});
  const first=svc.runHistory(row.id).items[0]!;
  assert.equal(first.status,'failed');assert.equal(first.trigger,'manual');assert.equal(first.page,1);
  assert.deepEqual([first.readCount,first.newCount,first.totalEntries,first.entries.length],[12,12,12,10]);
  assert.deepEqual(first.delivered,{inbox:1,knowledge:0});assert.deepEqual(first.pending,{inbox:11,knowledge:12});
  assert.deepEqual(first.entries[0],{title:'条目 0 [链接]',delivered:['inbox'],pending:['knowledge']});
  assert.doesNotMatch(JSON.stringify(first),/敏感正文|secret\.invalid|secret-cursor|内部秘密/);
  await svc.close();store.close();store=createStore(path);svc=open();failed=false;
  await svc.pull(row.id,1);
  const repaired=svc.runHistory(row.id).items[0]!;
  assert.equal(repaired.status,'completed');assert.equal(repaired.readCount,null);assert.equal(repaired.newCount,0);
  assert.deepEqual(repaired.delivered,{inbox:11,knowledge:12});assert.deepEqual(repaired.pending,{inbox:0,knowledge:0});
  await svc.tick();
  const terminal=svc.runHistory(row.id).items[0]!;
  assert.ok(terminal.durationMs!==undefined && terminal.durationMs>=0);assert.equal(terminal.trigger,'schedule');assert.equal(terminal.page,2);assert.equal(terminal.readCount,0);
  const old=svc.runHistory(row.id).items.at(-1);assert.deepEqual(old,first);
  for(let n=0;n<21;n++)await svc.pull(row.id,1);
  const recent=svc.runHistory(row.id).items;assert.equal(recent.length,20);assert.ok(!recent.some(x=>x.id===first.id));
  svc.remove(row.id,1);assert.throws(()=>svc.runHistory(row.id),{status:404});
});

test('启动后的进行中记录可查；上次进程未确认的运行恢复为中断',async t=>{
  const dir=await mkdtemp(join(tmpdir(),'sm-sub-crash-')),path=join(dir,'test.db');
  const store=createStore(path);let unblock!:()=>void;
  const gate=new Promise<void>(resolve=>{unblock=resolve;});
  const svc=createSourceSubscriptions({store,sources:()=>[src],async read(){await gate;return [];},deliver(){}});
  const row=svc.create(input);const active=svc.pull(row.id,1);
  const pending=svc.runHistory(row.id).items[0]!;assert.equal(pending.status,'running');assert.equal(pending.readCount,null);
  await assert.rejects(svc.pull(row.id,1),{status:409});assert.equal(svc.runHistory(row.id).items.length,1);
  // Copy the committed SQLite file at the crash point, without running service teardown on that database.
  const {copyFile}=await import('node:fs/promises');const saved=join(dir,'crashed.db');await copyFile(path,saved);
  const copy=createStore(saved);
  const reboot=createSourceSubscriptions({store:copy,sources:()=>[src],read:async()=>[],deliver(){}});
  try{
    const prior=reboot.runHistory(row.id).items[0]!;
    assert.equal(prior.id,pending.id);assert.equal(prior.status,'interrupted');assert.ok(prior.interruptionObservedAt);assert.equal(prior.finishedAt,undefined);assert.equal(prior.durationMs,undefined);
    assert.deepEqual(prior.delivered,{inbox:0,knowledge:0});assert.equal(prior.readCount,null);
  }finally{await reboot.close();copy.close();unblock();await active;await svc.close();store.close();await rm(dir,{recursive:true,force:true});}
});

test('停机时保留已确认的收件回执，未知的知识写入重启后按稳定键补核',async t=>{
  const store=createStore(':memory:');
  t.after(()=>store.close());
  let started!:()=>void, release!:()=>void;
  const entering=new Promise<void>(resolve=>{started=resolve;});
  const gate=new Promise<void>(resolve=>{release=resolve;});
  const writes=new Set<string>();
  function open(block:boolean){return createSourceSubscriptions({store,sources:()=>[src],
    async read(){return [rowItem(1)];},
    async deliver(dest,key){
      writes.add(key);
      if(dest==='knowledge' && block){started();await gate;}
    },
  });}
  const first=open(true),sub=first.create(input);
  const request=assert.rejects(first.pull(sub.id,1));
  await entering;
  const stopping=first.close();let drained=false;
  const concurrent=first.close().then(()=>{drained=true;});
  try {
    await new Promise<void>(resolve=>setImmediate(resolve));
    assert.equal(drained,false);
  }finally{release();await Promise.all([stopping,concurrent,request]);}
  const second=open(false);t.after(()=>second.close());
  const [old]=second.runHistory(sub.id).items;
  assert.ok(old);assert.equal(old.status,'interrupted');
  assert.deepEqual(old.delivered,{inbox:1,knowledge:0});assert.deepEqual(old.pending,{inbox:0,knowledge:1});
  await second.pull(sub.id,1);
  const [replay]=second.runHistory(sub.id).items;
  assert.deepEqual(replay!.delivered,{inbox:0,knowledge:1});assert.equal(writes.size,2);
});
