import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createFeishuIntegration, preparePersonalCheckpoint } from '../plugins/feishu.ts';
import { createPersonalMessages } from '../apps/server/src/feishu-personal.ts';
import type { PersonalCheckpoint } from '../plugins/feishu.ts';
import type { PersonalProvider } from '../plugins/feishu-personal.ts';
const account={appId:'cli_incremental',profile:'isolated',openId:'ou_owner',name:'隔离账号'};
const get=(args:string[],flag:string)=>args[args.indexOf(flag)+1];
const ok=(data:unknown)=>({ok:true,identity:'user',data});
const msg=(id:string)=>({message_id:id,chat_id:'oc_private',chat_type:'p2p',content:'隔离读取消息',sender:{id:'ou_other',id_type:'open_id'},create_time:'2026-11-20T02:00:00Z'});

test('bounded collection prioritizes private pagination, selects only recent active normal unmuted groups and resumes persisted routes',async t=>{
 let now=Date.parse('2026-11-20T03:00:00Z');t.mock.method(Date,'now',()=>now);
 const calls:string[][]=[];let firstPrivate=true;
 const runCLI=async(args:string[])=>{
  calls.push(args);
  if(args.includes('+chat-list')){assert.equal(get(args,'--sort'),'active_time');assert.ok(!args.includes('--page-token'));return ok({chats:[...Array.from({length:25},(_,n)=>({chat_id:'oc_g'+n,chat_status:'normal'})),{chat_id:'oc_closed',chat_status:'dissolved'},{chat_id:'oc_muted',chat_status:'normal'}],has_more:true,page_token:'do-not-enumerate-old-groups'});}
  if(args.includes('batch_query'))return ok({items:JSON.parse(get(args,'--data')).chat_ids.map((chat_id:string)=>({chat_id,is_muted:chat_id==='oc_muted'}))});
  assert.ok(args.includes('+messages-search'));
  if(get(args,'--chat-type')==='p2p'){
   if(firstPrivate){firstPrivate=false;return ok({messages:[msg('om_first')],has_more:true,page_token:'private-next'});}
   return ok({messages:[{...msg('om_private'),create_time:new Date(now-1000).toISOString()}],has_more:false});
  }
  assert.doesNotMatch(get(args,'--chat-id'),/oc_closed|oc_muted/);return ok({messages:[],has_more:false});
 };
 const make=()=>createFeishuIntegration({...account,appSecret:'',personalOpenId:account.openId,personalCollectionPageLimit:3,runCLI,onMessage:async()=>{},onInbox:async()=>{}});
 let adapter=make();t.after(()=>adapter.close());
 const checkpoint=preparePersonalCheckpoint(account);checkpoint.window!.start='2026-11-20T01:00:00Z';
 const first=await adapter.collectBatch(checkpoint);assert.equal(first.checkpoint.pages,1);assert.equal(first.items.length,1);assert.ok(!calls.some(args=>args.includes('+chat-list')));
 assert.equal(first.checkpoint.directThrough,undefined);assert.equal(first.checkpoint.groupRetryFrom,undefined);
 const before=calls.length,second=await adapter.collectBatch(first.checkpoint);
 assert.equal(calls.slice(before).filter(args=>args.includes('+messages-search')).length,3);assert.equal(second.checkpoint.window!.lanes.length,7);assert.equal(second.hasMore,true);
 assert.equal(calls.filter(args=>args.includes('+chat-list')).length,1);
 const oldEnd=second.checkpoint.window!.end;await adapter.close();adapter=make();now+=3600000;
 const start=calls.length,third=await adapter.collectBatch(JSON.parse(JSON.stringify(second.checkpoint)));
 const searches=calls.slice(start).filter(args=>args.includes('+messages-search'));
 assert.equal(searches.length,3);assert.equal(get(searches[0],'--end'),new Date(now).toISOString().replace('.000Z','Z'));
 assert.ok(searches.slice(1).every(args=>get(args,'--end')===oldEnd),'group range never follows the advancing private end');
 assert.equal(calls.filter(args=>args.includes('+chat-list')).length,1,'restart does not rescan the directory');
 assert.equal(third.checkpoint.directThrough,new Date(now).toISOString().replace('.000Z','Z'));
 assert.ok(third.items.some(item=>item.last==='om_private'));assert.equal(third.checkpoint.lastCompletedThrough,undefined);
});

test('unavailable group directory defers only groups and still returns private records and durable progress',async t=>{
 let directoryCalls=0;
 const adapter=createFeishuIntegration({...account,appSecret:'',personalOpenId:account.openId,personalCollectionPageLimit:3,
  runCLI:async args=>{if(args.includes('+chat-list')){directoryCalls++;throw Error('controlled group outage');}return ok({messages:[msg('om_available')],has_more:false});},onMessage:async()=>{},onInbox:async()=>{}});
 t.after(()=>adapter.close());const first=await adapter.collectBatch();
 assert.equal(first.items.length,1);assert.ok(first.checkpoint.directThrough);assert.ok(first.checkpoint.window!.directory!.retryAt!>Date.now());assert.equal(first.checkpoint.lastCompletedThrough,undefined);
 const second=await adapter.collectBatch(first.checkpoint);assert.equal(second.items.length,1);assert.equal(directoryCalls,1,'deferred groups do not hammer the directory');
});

test('personal host accepts and resumes a partial checkpoint, exposes private progress and never exposes tokens',async t=>{
 const dir=mkdtempSync(join(tmpdir(),'mario-incremental-host-'));mkdirSync(join(dir,'private/feishu-personal'),{recursive:true});
 const initial:PersonalCheckpoint={version:1,binding:account,pages:3,directThrough:'2026-11-20T03:00:00Z',groupRetryFrom:'2026-11-20T01:00:00Z',window:{start:'2026-11-20T01:00:00Z',end:'2026-11-20T02:00:00Z',privateRange:{start:'2026-11-20T02:55:00Z',end:'2026-11-20T03:00:00Z'},directory:{done:true},lanes:[{done:true,seen:[]},{done:false,seen:[],chatIds:['oc_group'],mentions:true,token:'private-cursor-sentinel'}]}};
 const file=join(dir,'private/feishu-personal/account.json');writeFileSync(file,JSON.stringify({enabled:true,account,checkpoint:initial}));
 let release!:()=>void;const gate=new Promise<void>(r=>release=r);let seen:PersonalCheckpoint|undefined;
 const provider={verify:async()=>account,collectBatch:async(_a:unknown,_s:unknown,c:PersonalCheckpoint)=>{seen=c;await gate;return{items:[],checkpoint:c,hasMore:true};}} as unknown as PersonalProvider;
 const service=createPersonalMessages({config:{host:'127.0.0.1',port:0,dataDir:dir,demo:false},provider,canCollect:()=>true,ingest:async()=>{}});
 t.after(async()=>{release();await service.close();rmSync(dir,{recursive:true,force:true});});service.start();
 for(let n=0;n<100&&!seen;n++)await new Promise(r=>setTimeout(r,5));assert.ok(seen);assert.equal(seen.window!.lanes[1].token,'private-cursor-sentinel');
 assert.equal(service.status().collecting,true);assert.equal(service.status().privateCompletedThrough,initial.directThrough);assert.doesNotMatch(JSON.stringify(service.status()),/private-cursor-sentinel|isolated|cli_incremental/);
 release();await service.collect();assert.equal(JSON.parse(readFileSync(file,'utf8')).checkpoint.window.directory.done,true);
});
