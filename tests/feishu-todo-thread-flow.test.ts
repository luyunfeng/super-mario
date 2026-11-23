import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import type { EventDispatcher } from '@larksuiteoapi/node-sdk';
import { startServer } from '../apps/server/src/index.ts';
import { createFeishuIntegration, type FeishuOptions } from '../plugins/feishu.ts';
import type { Todo } from '../packages/protocol/src/index.ts';

type Thread = {channel:string; chatId:string; threadId:string; botName?:string; chatName?:string; title?:string; version:string};

async function fixture(t:test.TestContext) {
  const dir = await mkdtemp(join(tmpdir(),'sm-todo-thread-'));
  const config = {dataDir:dir,port:0,host:'127.0.0.1',token:'fixture-token',demo:true};
  let dispatcher!: EventDispatcher;
  const sent: {id:string;chat:string;parent?:string;text:string}[] = [];
  const chats = new Map<string,string>();
  const botFactory = (options:FeishuOptions) => createFeishuIntegration({...options,
    wsFactory: opts => ({async start(input) {dispatcher = input.eventDispatcher; opts.onReady?.();},close(){},
      getConnectionStatus:()=>({state:'connected',reconnectAttempts:0})}),
    fetch: async (url,init) => {
      const path = new URL(String(url)).pathname;
      const ok = (data:object) => Response.json({code:0,...data});
      if (path.endsWith('/tenant_access_token/internal')) return ok({tenant_access_token:'stub',expire:3600});
      if (path.endsWith('/bot/v3/info')) return ok({bot:{open_id:'ou_bot'}});
      if (path.endsWith('/reactions')) return ok({data:{reaction_id:'synthetic-reaction'}});
      if (init?.method === 'GET') {
        const id = path.split('/').at(-1)!;
        assert.equal(chats.get(id),'oc_home');
        return ok({data:{items:[{message_id:id,chat_id:'oc_home',thread_id:'omt_home'}]}});
      }
      const body = JSON.parse(String(init?.body)), parent = path.match(/\/messages\/([^/]+)\/reply$/)?.[1];
      const chat = parent ? chats.get(parent) : body.receive_id;
      assert.ok(chat);
      const id = 'om_ack_' + sent.length;
      sent.push({id,chat,parent,text:body.content}); chats.set(id,chat);
      return ok({data:{message_id:id}});
    }});
  let server = await startServer(config,{botFactory});
  t.after(async()=>{try {await server.close();} finally {await rm(dir,{recursive:true,force:true});}});
  async function api<T>(path:string,method='GET',body?:object,status=200,token=config.token) {
    const response = await fetch(server.url+'/api/v1/'+path,{method,headers:{authorization:'Bearer '+token,'content-type':'application/json'},
      ...(body && {body:JSON.stringify(body)})});
    assert.equal(response.status,status,path);
    return response.json() as Promise<T>;
  }
  let seq = 0;
  async function event(id:string,chat:string,text:string,thread?:string,root?:string,mention=false) {
    chats.set(id,chat);
    await dispatcher.invoke({schema:'2.0',header:{event_type:'im.message.receive_v1',event_id:'ev_'+(++seq)},event:{
      sender:{sender_type:'user',sender_id:{open_id:'ou_owner'}}, message:{message_id:id,chat_id:chat,chat_type:chat==='oc_private'?'p2p':'group',
        thread_id:thread,root_id:root,parent_id:root,message_type:'text',content:JSON.stringify({text:(mention?'@_user_1 ':'')+text}),
        mentions:mention?[{key:'@_user_1',id:{open_id:'ou_bot'},name:'测试机器人'}]:[]}}},{needCheck:false});
  }
  const bot = await server.bots.create({name:'测试机器人',appId:'cli_5555555555555555',appSecret:'fixture',scope:{kind:'global'}});
  await event('om_pair','oc_private',bot.pairingCode!);
  await t.waitFor(()=>assert.ok(server.bots.list().some(row=>row.paired)));
  await event('om_enroll','oc_direct','/topics',undefined,undefined,true);
  await event('om_register_home','oc_home','/topics home',undefined,undefined,true);
  async function restart() {
    await server.close(); server=await startServer(config,{botFactory});
    await t.waitFor(()=>assert.ok(server.bots.list().some(row=>row.connected)));
  }
  function removeReverse(todo:Todo) {
    assert.ok(server.app.store.list('feishu.topic-todos').includes(todo.id));
    assert.ok(server.app.store.remove?.('feishu.todo-topic-bindings',todo.id));
  }
  return {bot,event,api,sent,restart,removeReverse};
}

test('Web 查看并解绑飞书话题，旧决定、重放和重启不会恢复绑定，同话题可新建待办', {timeout:40000}, async t => {
  const {bot,event,api,sent,restart,removeReverse} = await fixture(t);
  const registryPath = 'feishu/bots/'+bot.id+'/topic-chats';
  const registry = await api<{binding:string;version:number;items:{chatId:string;name:string}[]}>(registryPath);
  const groupNames = new Map([['oc_direct','直接任务群'],['oc_home','调度主群']]);
  await api(registryPath,'PUT',{...registry,items:registry.items.map(item=>({...item,name:groupNames.get(item.chatId)}))});
  const directTitle='直接话题的合成任务', homeTitle='委托主群的合成任务';
  const directOpen=()=>event('om_direct','oc_direct',directTitle,'omt_direct');
  const externalOpen=()=>event('om_external','oc_source','/ai '+homeTitle,undefined,undefined,true);
  await directOpen(); await externalOpen();
  const findTodo = (title:string) => t.waitFor(async()=>{
    const todo = (await api<Todo[]>('todos')).find(row=>row.title===title); assert.ok(todo); return todo;
  },{timeout:6500});
  const direct = await findTodo(directTitle), home = await findTodo(homeTitle);
  const waitAnswer = (parent:string) => t.waitFor(()=>assert.ok(sent.some(row=>row.parent===parent)),{timeout:8000});
  await waitAnswer('om_direct');
  const opening = await t.waitFor(()=>{const m=sent.find(row=>row.chat==='oc_home'&&!row.parent&&row.text.includes(homeTitle)); assert.ok(m);return m;});
  await waitAnswer(opening.id);
  const path = (todo:Todo) => 'todos/'+todo.id+'/thread';
  const read = async(todo:Todo) => (await api<{thread:Thread|null}>(path(todo))).thread;
  const link = async(todo:Todo,chat:string,topic:string) => {
    const thread = await read(todo); assert.ok(thread);
    assert.deepEqual([thread.channel,thread.chatId,thread.threadId],['feishu',chat,topic]);
    assert.equal(typeof thread.version,'string'); assert.ok(thread.version);
    return thread;
  };
  await api('todos/unknown-fixture-id/thread','GET',undefined,404);
  const ordinary = await api<Todo>('todos','POST',{title:'普通待办'},201);
  assert.equal(await read(ordinary),null);
  // Pre-upgrade databases have a one-way mapping plus committed opening routes and enrollment.
  removeReverse(direct); removeReverse(home);
  await restart();
  const a = await link(direct,'oc_direct','omt_direct'), b = await link(home,'oc_home','omt_home');
  assert.notEqual(a.version,b.version);
  assert.deepEqual([a.botName,a.chatName,b.botName,b.chatName],[bot.name,'直接任务群',bot.name,'调度主群']);
  const countBeforeReplay = (await api<Todo[]>('todos')).length;
  const sentBeforeReplay = sent.length;
  await directOpen(); await externalOpen();
  assert.equal((await api<Todo[]>('todos')).length,countBeforeReplay);
  assert.deepEqual(await read(direct),a); assert.deepEqual(await read(home),b);
  assert.ok(!sent.slice(sentBeforeReplay).some(row=>row.parent==='om_direct' || row.chat==='oc_home'));
  for(const method of ['GET','DELETE']) await api(path(direct),method,method==='DELETE'?{expectedVersion:a.version}:undefined,401,'wrong-key');
  await api(path(direct),'DELETE',{expectedVersion:b.version},409);
  assert.deepEqual(await read(direct),a);
  const decide=(todo:Todo,text:string)=>api('todos/'+todo.id+'/decisions','POST',{text,expectedProjectId:null},201);
  await decide(direct,'解除前排队的私有决定');
  await decide(home,'主群解绑前排队的私有决定');
  await api(path(direct),'DELETE',{expectedVersion:a.version});
  await api(path(home),'DELETE',{expectedVersion:b.version});
  assert.equal(await read(direct),null); assert.equal(await read(home),null);
  await restart();
  const after = sent.length;
  const total = (await api<Todo[]>('todos')).length;
  await directOpen(); await externalOpen();
  assert.equal((await api<Todo[]>('todos')).length,total);
  assert.equal(await read(direct),null); assert.equal(await read(home),null);
  const nextTitle='同一话题的新委托';
  await event('om_new','oc_direct','/ai '+nextTitle,'omt_direct','om_direct',true);
  const next = await findTodo(nextTitle); assert.notEqual(next.id,direct.id);
  await waitAnswer('om_new');
  const current = await link(next,'oc_direct','omt_direct');
  assert.notEqual(current.version,a.version);
  await api(path(next),'DELETE',{expectedVersion:a.version},409);
  await decide(direct,'直接话题解绑后的决定'); await decide(home,'主群解绑后的决定');
  await api('todos/'+direct.id,'PATCH',{completed:true}); await api('todos/'+home.id,'PATCH',{completed:true});
  await decide(next,'新待办的决定');
  await t.waitFor(()=>assert.ok(sent.slice(after).some(row=>row.parent==='om_new' && row.text.includes('待办新增 1 项决定'))),{timeout:8000});
  const notices = sent.slice(after).filter(row => ['oc_direct','oc_home'].includes(row.chat) && /待办新增|这项待办已完成|分钟后回复原群消息/.test(row.text));
  assert.deepEqual(notices.map(row=>row.parent),['om_new']);
  const latest = await api<{decisions:{text:string}[]}>('todos/'+next.id+'/decisions');
  assert.deepEqual(latest.decisions.map(row=>row.text),['新待办的决定']);
});

test('Web 绑定既有待办后首条主人发言成为决定，换绑及重复绑定隔离旧消息', {timeout:40000}, async t => {
  const {api,bot,event,sent,restart} = await fixture(t);
  const todo = await api<Todo>('todos','POST',{title:'原有待办'},201);
  const path = 'todos/'+todo.id+'/thread';
  const read = async() => (await api<{thread:Thread}>(path)).thread;
  const bind = (threadId:string,expectedVersion:string|null,status=200) =>
    api(path,'PUT',{channel:'feishu',botId:bot.id,chatId:'oc_direct',threadId,title:'验收话题名-'+threadId,expectedVersion},status);
  const decisions = async() => (await api<{decisions:{text:string}[]}>('todos/'+todo.id+'/decisions')).decisions.map(row=>row.text);
  const add = (text:string) => api('todos/'+todo.id+'/decisions','POST',{text,expectedProjectId:null},201);
  const waitReply = (parent:string,text:string) => t.waitFor(()=>assert.ok(sent.some(row=>row.parent===parent && row.text.includes(text))),{timeout:8000});
  const sendA = () => event('om_first_a','oc_direct','甲话题第一项决定','omt_web_a','om_root_a');
  const sendB = () => event('om_first_b','oc_direct','乙话题第一项决定','omt_web_b','om_root_b');
  const baseline = sent.length;
  await bind('omt_web_a',null);
  const a = await read(); assert.equal(a.title,'验收话题名-omt_web_a'); assert.equal(a.threadId,'omt_web_a'); assert.equal(sent.length,baseline);
  await sendA(); await waitReply('om_first_a','甲话题第一项决定');
  assert.deepEqual(await decisions(),['甲话题第一项决定']);
  await add('排队中换绑的私有决定');
  await bind('omt_web_b','obsolete',409);
  const staleTarget = {channel:'feishu', botId:bot.id, chatId:'oc_direct', threadId:'omt_web_b', expectedVersion:a.version};
  for (const stale of [{titleOnly:true,expectedTitle:a.title}, {threadId:a.threadId,titleOnly:true,expectedTitle:'过期标题'}, {expectedBotBinding:'previous-owner'}, {expectedRegistryVersion:-1}, {expectedProjectId:'previous-project'}])
    await api(path,'PUT',{...staleTarget,...stale},409);
  assert.deepEqual(await read(), a);
  const beforeSwitch = sent.length;
  await bind('omt_web_b',a.version);
  const b = await read(); assert.equal(b.threadId,'omt_web_b'); assert.notEqual(a.version,b.version);
  assert.equal(sent.length,beforeSwitch);
  await event('om_stale_follow','oc_direct','旧话题不能追加此决定','omt_web_a','om_root_a');
  await sendB(); await waitReply('om_first_b','乙话题第一项决定');
  await add('有效的 Web 决定');
  await waitReply('om_first_b','待办新增 1 项决定');
  assert.ok(!sent.slice(beforeSwitch).some(row=>row.parent==='om_first_a' && row.text.includes('待办新增')));
  assert.ok(!(await decisions()).includes('旧话题不能追加此决定'));
  await api(path,'DELETE',{expectedVersion:b.version});
  await bind('omt_web_b',null);
  assert.notEqual((await read()).version,b.version);
  await restart();
  const beforeReplay = sent.length;
  await sendB();
  assert.equal((await decisions()).filter(text=>text==='乙话题第一项决定').length,1);
  const last = sent.length;
  await event('om_second_b','oc_direct','再次绑定后的新决定','omt_web_b','om_root_b');
  await waitReply('om_second_b','再次绑定后的新决定');
  assert.ok(!sent.slice(beforeReplay).some(row=>row.parent==='om_first_b' && row.text.includes('乙话题第一项决定')));
  assert.equal((await decisions()).filter(text=>text==='再次绑定后的新决定').length,1);
  await api('todos/'+todo.id,'PATCH',{completed:true});
  await waitReply('om_second_b','这项待办已完成');
  assert.deepEqual(sent.slice(last).filter(row=>row.text.includes('这项待办已完成')).map(row=>row.parent),['om_second_b']);
});
