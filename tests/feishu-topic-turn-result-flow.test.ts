import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';
import { startAgentNode } from '../apps/agent-node/src/index.ts';
import { startServer } from '../apps/server/src/index.ts';
import type { Approval, JsonObject, Run, Todo } from '../packages/protocol/src/index.ts';
import type { FeishuOptions, FeishuSendContext } from '../plugins/feishu.ts';

test('获批输入的原生单轮答复返回准确的原群话题，错误归属、撤权与重放不外发', {timeout:60000}, async t => {
  const dir = await mkdtemp(join(tmpdir(),'topic-turn-result-'));
  const config = {host:'127.0.0.1',port:0,dataDir:dir,demo:true,token:'fixture'};
  const machineId = 'synthetic-node';
  let events!: FeishuOptions;
  const sent: Array<{chat:string;text:string;ctx?:FeishuSendContext}> = [];
  const factory = (opts:FeishuOptions) => {
    events = opts;
    return {async start() {}, async close() {}, async collect() {return [];}, status:() => ({connected:true}),
      async send(chat:string,text:string,ctx?:FeishuSendContext) {
        ctx?.beforeSend?.(); ctx?.groupReadReply?.(); sent.push({chat,text,ctx}); ctx?.onSent?.('om_ack_' + sent.length,'text');
      }};
  };
  const open = () => startServer(config,{botFactory:factory});
  let server = await open();
  const writes: JsonObject[] = [], reads: JsonObject[] = [], legacy: JsonObject[] = [];
  const turns = new Map<string,{native:string;local:string;turn:string;input:string;text:string}>();
  const pendingText = '服务重启前已获批准的输入';
  let pendingCompleted = false;
  let release!: () => void;
  const held = new Promise<void>(resolve => {release=resolve;});
  const node = () => startAgentNode({url:server.url,token:config.token,dataDir:join(dir,'node'),machineId,name:'合成执行机',
    executors:[{id:'codex',name:'协议替身',machineId,mode:'real',kind:'cli',available:true,description:'',nativeResultSources:['codex-json']}],
    handlers:{
      'agents.session': async p => ({...p,id:'codex:' + p.nativeSessionId,source:'session-metadata',state:'historical',writable:false,observedAt:new Date().toISOString()}),
      'executor.resume': async p => ({sessionId:'local-' + p.nativeSessionId}),
      'executor.input': async p => {legacy.push(p); return {requested:true};},
      'executor.input.once': async p => {
        writes.push(p);
        const local = String(p.sessionId), native = local.slice('local-'.length), input = String(p.clientMessageId), turn = 'turn-' + input;
        turns.set(input,{native,local,turn,input,text:String(p.text)});
        return {requested:true,clientMessageId:input,nativeSessionId:native,turnId:turn};
      },
      'executor.turnResult': async (p):Promise<JsonObject> => {
        reads.push(p);
        const v = turns.get(String(p.clientMessageId)); assert.ok(v);
        assert.equal(p.nativeSessionId,v.native); assert.equal(p.sessionId,v.local); assert.equal(p.turnId,v.turn);
        const proof = {sessionId:v.local,nativeSessionId:v.native,turnId:v.turn,clientMessageId:v.input};
        const result = { ...proof, state:'completed', source:'codex-app-server', text:'单轮最终正文-' + v.text };
        switch (v.text) {
          case pendingText: if (!pendingCompleted) return {...proof, state:'running', source:'codex-app-server', text:''}; break;
          case '屏幕来源': return {...result,source:'screen'};
          case '错误输入标识': return {...result,clientMessageId:'other-client-input'};
          case '错误执行机会话': return {...result,sessionId:'local-unrelated'};
          case '错误原生线程': return {...result,nativeSessionId:'another-native-session'};
          case '错误轮次标识': return {...result,turnId:'another-turn'};
          case '失败正文': return {...result,state:'failed'};
          case '撤权在途': await held; break;
        }
        return result;
      },
    }});
  let machine = node();
  t.after(async () => { release(); try { await machine.close(); await server.close(); } finally { await rm(dir,{recursive:true,force:true}); } });
  const api = async <T,>(path:string,method='GET',body?:object) => {
    const res = await fetch(server.url + '/api/v1/' + path,{method,headers:{authorization:'Bearer fixture','content-type':'application/json'},
      ...(body && {body:JSON.stringify(body)})});
    if (!res.ok) throw Error(path + ' HTTP ' + res.status + ' ' + await res.text());
    return res.json() as Promise<T>;
  };
  const approve = (a:Approval) => api<Approval>('approvals/' + a.id + '/approve','POST',{version:a.version});
  const wait = (check:()=>void) => t.waitFor(check,{timeout:9000});
  const send = (key:string,id:string,text:string,extra:{threadId?:string;rootId?:string;chatType?:string} = {}) =>
    events.onMessage(text,{chatId:'oc_' + key,chatType:'group',senderType:'user',senderId:'ou_owner',messageId:id,...extra});
  const bot = await server.bots.create({name:'合成话题助手',appId:'cli_5555555555555555',appSecret:'fixture',scope:{kind:'global'}});
  await send('private','om_pair',bot.pairingCode!,{chatType:'p2p'});
  await wait(() => assert.ok(server.machines.list().find(m => m.id === machineId)?.online));
  async function setup(key:string) {
    await send(key,'om_enroll_' + key,'/topics');
    const title = '合成任务-' + key;
    await send(key,'om_root_' + key,title,{threadId:'omt_' + key});
    await wait(() => assert.ok(sent.some(s => s.ctx?.replyTo === 'om_root_' + key && s.text.includes(title))));
    const todo = (await api<Todo[]>('todos')).find(t => t.title === title)!;
    const native = 'native-' + key;
    const a = await api<Approval>('agents/sessions/resume','POST',{machineId,executorId:'codex',nativeSessionId:native,cwd:dir,
      executionMode:'interactive',key:'resume-' + key,todoId:todo.id,prompt:'继续合成话题任务'});
    assert.equal((await approve(a)).status,'completed');
    const run = await t.waitFor(async () => {
      const r = (await api<{runs:Run[]}>('state')).runs.find(r => r.todoId === todo.id && r.status === 'running' && r.sessionId);
      assert.ok(r); return r;
    });
    assert.equal(run.nativeResume?.nativeSessionId,native);
    await api('todos/' + todo.id,'PATCH',{responsibleRunId:run.id});
  }
  async function approval(key:string,id:string,text:string) {
    await send(key,id,text,{threadId:'omt_' + key,rootId:'om_root_' + key});
    const a = (await api<Approval[]>('approvals')).find(a => a.kind === 'input' && a.params.text === text);
    assert.ok(a); return a;
  }
  await setup('a'); await setup('b');
  const [left,right] = await Promise.all([approval('a','om_left','左侧答复'),approval('b','om_right','右侧答复')]);
  for (const a of [left,right]) {
    const frozen = server.app.store.get<{topic:{publishTurnResult?:boolean}}>('feishu.agent-input-targets',a.id);
    assert.equal(frozen?.topic.publishTurnResult,true);
    assert.match(a.details,/最终答复.*公开.*原飞书话题/);
    assert.equal(a.params.publishTurnResult,true);
  }
  const approved = await Promise.all([approve(left),approve(right)]);
  assert.ok(approved.every(a => a.status === 'completed'));
  const visible = () => sent.filter(s => s.text.includes('单轮最终正文-'));
  await wait(() => assert.equal(visible().length,2));
  const destinations = () => visible().map(s => [s.chat,s.ctx?.threadId,s.ctx?.replyTo,s.text]).sort();
  const originals = destinations();
  assert.deepEqual(originals.map(r=>r.slice(0,3)),[['oc_a','omt_a','om_left'],['oc_b','omt_b','om_right']]);
  assert.ok(originals[0][3]?.includes('左侧答复') && !originals[0][3]?.includes('右侧答复'));
  assert.ok(originals[1][3]?.includes('右侧答复') && !originals[1][3]?.includes('左侧答复'));
  for (const [index,text] of ['错误输入标识','错误执行机会话','错误原生线程','错误轮次标识','屏幕来源','失败正文','撤权在途'].entries()) {
    const a = await approval('a','om_negative_' + index,text);
    assert.equal((await approve(a)).status,'completed');
    const write = writes.find(p => p.text === text)!;
    await wait(() => assert.ok(reads.some(p => p.clientMessageId === write.clientMessageId)));
  }
  await send('a','om_revoke','/topics off'); release();
  const barrier = await approval('b','om_barrier','独立控制消息');
  await approve(barrier);
  await wait(() => assert.ok(visible().some(s => s.text.includes('独立控制消息'))));
  assert.equal(visible().length,3);
  const before = destinations();
  const pending = await approval('b','om_pending',pendingText);
  assert.equal((await approve(pending)).status,'completed');
  const originalWrite = writes.find(p => p.text === pendingText);
  assert.ok(originalWrite);
  const pendingReads = () => reads.filter(p => p.clientMessageId === originalWrite.clientMessageId);
  await wait(() => assert.ok(pendingReads().length > 0));
  const readsBeforeRestart = pendingReads().length;
  const writesBeforeRestart = structuredClone(writes);
  assert.deepEqual(destinations(),before);
  await machine.close(); await server.close();
  pendingCompleted = true;
  server = await open();
  const state = await api<{runs:Run[]}>('state');
  assert.equal(state.runs.find(r => r.id === pending.params.id)?.status,'unknown');
  assert.deepEqual(destinations(),before);
  machine = node();
  await wait(() => assert.ok(server.machines.list().find(m => m.id === machineId)?.online));
  await wait(() => assert.ok(pendingReads().length > readsBeforeRestart));
  await wait(() => assert.ok(visible().some(s => s.ctx?.replyTo === 'om_pending')));
  const recovered = visible().filter(s => s.ctx?.replyTo === 'om_pending');
  assert.equal(recovered.length,1);
  assert.deepEqual([recovered[0].chat,recovered[0].ctx?.threadId],['oc_b','omt_b']);
  assert.ok(recovered[0].text.includes(pendingText));
  assert.deepEqual(writes,writesBeforeRestart);
  assert.equal((await api<{runs:Run[]}>('state')).runs.find(r => r.id === pending.params.id)?.status,'unknown');
  const afterRecovery = destinations();
  assert.deepEqual(afterRecovery.filter(row => row[2] !== 'om_pending'),before);
  await send('b','om_pending',pendingText,{threadId:'omt_b',rootId:'om_root_b'});
  await send('b','om_right','右侧答复',{threadId:'omt_b',rootId:'om_root_b'});
  const old = await api<Approval[]>('approvals');
  assert.equal(old.filter(a => a.kind === 'input' && a.params.text === '右侧答复').length,1);
  assert.deepEqual(destinations(),afterRecovery);
  await setup('after');
  await approve(await approval('after','om_new_control','重启控制消息'));
  await wait(() => assert.ok(visible().some(s => s.text.includes('重启控制消息'))));
  assert.deepEqual(destinations().filter(row => row[0] !== 'oc_after'),afterRecovery);
  assert.equal(writes.length,12); assert.equal(legacy.length,0);
});
