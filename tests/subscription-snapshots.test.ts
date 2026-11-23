import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import test from 'node:test';
import {createStore} from '../packages/core/src/store.ts';
import {createSourceSubscriptions} from '../packages/core/src/source-subscriptions.ts';

const source={id:'fixture.state',name:'状态',resourceLabel:'资源',mode:'snapshot' as const};
const input={sourceId:source.id,name:'状态订阅',resource:'fixture',destinations:['inbox']};
const first=Date.parse('2026-01-05T05:05:00Z');
const iso=(v:number)=>new Date(v).toISOString();

test('快照首次立即，每日按指定时区；固定间隔可编辑并独立于条目型来源',async t=>{
  t.mock.timers.enable({apis:['Date'],now:first});
  const store=createStore(':memory:');
  let timezone='America/New_York';
  const svc=createSourceSubscriptions({store,sources:()=>[source],timezone:()=>timezone,read:async()=>({snapshot:{title:'标题',text:'内容'}}),deliver(){}});
  t.after(async()=>{await svc.close();store.close();});
  const row=svc.create(input);assert.equal(row.mode,'snapshot');assert.equal(row.dailyAt,'08:00');assert.equal(row.nextRunAt,iso(first));
  await svc.tick();assert.equal(svc.list()[0]?.nextRunAt,'2026-01-05T13:00:00.000Z');
  svc.syncTimezone();timezone='Asia/Shanghai';svc.syncTimezone();
  assert.equal(svc.list()[0]?.nextRunAt,'2026-01-06T00:00:00.000Z');
  timezone='America/New_York';svc.syncTimezone();
  const earlier=svc.update(row.id,{version:1,dailyAt:'04:15'});assert.equal(earlier.nextRunAt,'2026-01-05T09:15:00.000Z');
  assert.throws(()=>svc.update(row.id,{version:2,dailyAt:'25:30'}),{status:400});
  assert.throws(()=>svc.update(row.id,{version:2,dailyAt:'',intervalMinutes:59}),{status:400});
  const fixed=svc.update(row.id,{version:2,dailyAt:'',intervalMinutes:75});assert.equal(fixed.nextRunAt,iso(first+75*60000));
  const manual=svc.create({...input,intervalMinutes:60});assert.equal(manual.dailyAt,'');
  assert.throws(()=>svc.create({...input,intervalMinutes:1}),{status:400});
});

test('变化和恢复是不同记录；补投重启保留身份，预览比较归属且不写；知识库补全24h，收件只补最新',async t=>{
  t.mock.timers.enable({apis:['Date'],now:first});
  const dir=await mkdtemp(join(tmpdir(),'sm-snap-')),file=join(dir,'fixture.db');
  let store=createStore(file),text='A',fail=false;
  const delivered:{id:string;value:string;key:string;destination:string}[]=[];
  function open(){return createSourceSubscriptions({store,sources:()=>[source],read:async()=>({snapshot:{title:'当前',text}}),
    deliver(dest,key,item,sub){
      assert.equal(sub.mode,'snapshot');
      if(fail) throw new Error('合成断线');
      delivered.push({id:item.id,value:item.text,key,destination:dest});
    }});}
  let svc=open();t.after(async()=>{await svc.close();store.close();await rm(dir,{recursive:true,force:true});});
  const row=svc.create(input), registered={...input,subscriptionId:row.id};
  assert.equal((await svc.preview(input)).changed,undefined);
  assert.equal((await svc.preview(registered)).changed,true);
  assert.deepEqual(svc.snapshotHistory(row.id),{items:[]});
  await assert.rejects(svc.preview({...registered,resource:'other'}),{status:409});
  await svc.pull(row.id,1);assert.equal((await svc.preview(registered)).changed,false);
  await svc.pull(row.id,1);assert.equal(delivered.length,1);
  text='B';fail=true;await assert.rejects(svc.pull(row.id,1),{status:502});
  await svc.close();store.close();store=createStore(file);svc=open();fail=false;
  text='A';await svc.pull(row.id,1);
  assert.deepEqual(delivered.map(d=>d.value),['A','B','A']);
  assert.equal(new Set(delivered.map(d=>d.key)).size,3);
  const changes=svc.snapshotHistory(row.id).items;
  assert.deepEqual(changes.map(c=>[c.sequence,c.item.text]),[[3,'A'],[2,'B'],[1,'A']]);
  assert.doesNotMatch(JSON.stringify(changes),/digest/);
  const knowledge=svc.update(row.id,{version:1,destinations:['knowledge']});
  await svc.pull(row.id,knowledge.version);
  assert.deepEqual(delivered.filter(d=>d.destination==='knowledge').map(d=>d.value),['A','B','A']);
  text='C';await svc.pull(row.id,knowledge.version);text='D';await svc.pull(row.id,knowledge.version);
  const both=svc.update(row.id,{version:knowledge.version,destinations:['inbox','knowledge']});
  await svc.pull(row.id,both.version);
  assert.deepEqual(delivered.filter(d=>d.destination==='inbox').map(d=>d.value),['A','B','A','D']);
  t.mock.timers.setTime(first+86400001);
  assert.deepEqual(svc.snapshotHistory(row.id),{items:[]});
  text='E';await svc.pull(row.id,both.version);
  assert.deepEqual(svc.snapshotHistory(row.id).items.map(c=>c.sequence),[6]);
  svc.remove(row.id,both.version);assert.throws(()=>svc.snapshotHistory(row.id),{status:404});
});
