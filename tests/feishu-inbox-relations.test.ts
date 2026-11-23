import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import test from 'node:test';
import {startServer} from '../apps/server/src/index.ts';
import {createPersonalProvider,PERSONAL_MESSAGE_SCOPES} from '../plugins/feishu-personal.ts';
import {createStore} from '../packages/core/src/store.ts';
import {createEventBus} from '../packages/core/src/events.ts';
import {createReplyTracking} from '../packages/core/src/reply-tracking.ts';
import {inboxItemId} from '../packages/core/src/inbox.ts';

test('个人飞书只按同账号同会话的直接父消息关联，乱序重启后补连，尊重最新证据和人工归属',async t=>{
  const dataDir=await mkdtemp(join(tmpdir(),'mario-personal-parent-'));
  const appId='cli_local',owner='ou_local',other='ou_peer',chat='oc_sample';
  const source='feishu:'+appId+':'+owner;
  const key=(msg:string,c=chat)=>inboxItemId(source,'feishu:message:'+JSON.stringify([c,msg]));
  const message=(id:string,extra:Record<string,unknown>={})=>({
    chat_id:chat,message_id:id,chat_type:'p2p',msg_type:'text',sender:{id:other,id_type:'open_id',sender_type:'user'},
    content:'合成正文声称父消息是 om_fake',create_time:String(Math.floor(Date.now()/1000)),...extra,
  });
  let feed:ReturnType<typeof message>[]=[];
  const envelope=(data:object)=>({ok:true,identity:'user',data});
  const provider=createPersonalProvider({application:()=>undefined,runCLI:async args=>{
    if(args.includes('show')) return {profile:'fixture',appId};
    if(args.includes('--no-wait')) return {verification_url:'https://accounts.feishu.cn/oauth/v1/device/verify',device_code:'synthetic-code',expires_in:60};
    if(args.includes('--device-code')) return {ok:true};
    if(args.includes('--verify')) return {appId,identity:'user',verified:true,identities:{user:{available:true,openId:owner,userName:'合成账号',scope:PERSONAL_MESSAGE_SCOPES.join(' ')}}};
    if(args.includes('+chat-list')) return envelope({chats:[],has_more:false});
    if(args.includes('+messages-search')) return envelope({messages:feed,has_more:false});
    if(args.includes('chats') && args.includes('get')) return envelope({chat_mode:'p2p'});
    throw Error('未预期的平台调用');
  }});
  const start=()=>startServer({dataDir,host:'127.0.0.1',port:0,demo:true,token:'fixture'},{personalProvider:provider});
  let server=await start();
  t.after(async()=>{await server.close();await rm(dataDir,{recursive:true,force:true});});
  const connected=()=>t.waitFor(()=>assert.equal(server.personal.status().status,'connected'));
  const tree=(msg:string)=>server.app.inbox.tree(key(msg));
  server.personal.authorize();await connected();
  feed=[message('om_child',{parent_id:'om_old'}),message('om_fake'),message('om_noparent',{root_id:'om_fake',thread_id:'om_fake'})];
  await server.personal.enable(true);await server.personal.collect();
  assert.deepEqual(tree('om_child').ancestors,[]);
  assert.deepEqual(tree('om_noparent').ancestors,[]);
  feed=[message('om_child',{reply_to:'om_real'}),message('om_real',{chat_id:'oc_other'}),message('om_old')];
  await server.personal.collect();
  assert.deepEqual(tree('om_child').ancestors,[]);
  feed=[message('om_child',{thread_id:'om_fake',root_id:'om_fake'})];
  await server.personal.collect();
  await server.personal.enable(false);await server.close();
  server=await start();await connected();
  feed=[message('om_real')];
  await server.personal.enable(true);await server.personal.collect();
  assert.equal(tree('om_child').ancestors[0]?.id,key('om_real'));
  assert.equal(tree('om_child').item.parentInboxBy,'connector');
  const linked=tree('om_child').item;
  feed=[message('om_child',{parent_id:'om_real'}),message('om_real')];await server.personal.collect();
  assert.equal(tree('om_child').item.version,linked.version);

  server.app.inbox.setParent(linked.id,key('om_old'),linked.version);
  feed=[message('om_child',{parent_id:'om_fake'})];await server.personal.collect();
  assert.equal(tree('om_child').item.parentInboxId,key('om_old'));
  assert.equal(tree('om_child').item.parentInboxBy,'user');
  feed=[message('om_deleted_child',{parent_id:'om_future'}),message('om_other_child',{parent_id:'om_gone'})];
  await server.personal.collect();
  // Evidence is committed before ingestion. A failed collection may stop before parent indexes are reconciled.
  server.app.waitingReplies.observeSource(source,[{source,chatId:chat,messageId:'om_deleted_child',senderId:other,
    senderIdType:'open_id',createdAt:new Date().toISOString(),deleted:true}]);
  feed=[message('om_future')];await server.personal.collect();
  assert.equal(tree('om_deleted_child').item.parentInboxId,undefined);
  feed=[message('om_deleted_child',{deleted:true}),message('om_gone',{deleted:true}),message('om_own',{sender:{id:owner,id_type:'open_id'},parent_id:'om_absent'})];
  await server.personal.collect();
  assert.deepEqual(server.app.store.list('feishu.inbox-pending-parent'),[]);
  feed=[message('om_future'),message('om_history',{parent_id:'om_real'})];
  await server.personal.collect();
  assert.equal(tree('om_deleted_child').item.parentInboxId,undefined);
  assert.equal(tree('om_history').item.parentInboxId,key('om_real'));
  // A later deletion suppresses new proposals. It does not rewrite an already observed historical reply.
  feed=[message('om_real',{deleted:true}),message('om_new',{parent_id:'om_real'})];await server.personal.collect();
  assert.equal(tree('om_history').item.parentInboxId,key('om_real'));
  assert.equal(tree('om_new').item.parentInboxId,undefined);
  assert.equal(server.app.store.list('feishu.inbox-pending-children.'+key('om_future')).length,0);
});

test('撤回已观察消息会通知选取器；后来稀疏的直接回复投影不能重新取消提醒',t=>{
  const now=Date.UTC(2026,0,20);
  t.mock.timers.enable({apis:['Date'],now});
  const store=createStore(':memory:'),events=createEventBus(store);
  const tracking=createReplyTracking({store,events});
  t.after(()=>{tracking.close();store.close();});
  const source='feishu:test:owner',base={source,chatId:'oc_test',senderIdType:'open_id',createdAt:new Date(now-10000).toISOString()};
  store.put('todos','todo',{id:'todo',title:'等回执',waitingOn:'合成用户',reminderAt:new Date(now+60000).toISOString()});
  tracking.observeSource(source,[{...base,senderId:'owner',messageId:'ask'},{...base,senderId:'peer',messageId:'known'}]);
  const ask=tracking.sources('todo').items.find(item=>item.messageId==='ask')!;
  tracking.arm('todo',{key:'once',anchorId:ask.id,expectedSenderId:'peer',expectedSenderIdType:'open_id'});
  t.mock.timers.tick(1000);
  const reply={...base,senderId:'peer',messageId:'reply',createdAt:new Date().toISOString()};
  tracking.observeSource(source,[reply]);
  const cursor=events.since(0).at(-1)!.id;
  tracking.observeSource(source,[{...reply,deleted:true}]);
  assert.deepEqual(events.since(cursor).map(e=>[e.type,e.data]),[['waiting.replies.changed',{observed:0,matched:0}]]);
  assert.ok(!tracking.sources('todo').items.some(row=>row.messageId==='reply'));
  // The durable source marker also protects old databases without a corresponding consumption receipt.
  store.remove('todo.reply-evidence',JSON.stringify([source,base.chatId,reply.messageId]));
  assert.equal(tracking.observeSource(source,[{...reply,parentId:'ask'}]).matched,0);
  assert.equal(tracking.get('todo')?.status,'waiting');
});
