import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createProjectPurge } from '../packages/core/src/project-purge.ts';
import { createStore } from '../packages/core/src/store.ts';
import { startServer } from '../apps/server/src/index.ts';
import { startAgentNode } from '../apps/agent-node/src/index.ts';
import { setTimeout as delay } from 'node:timers/promises';

function deferred() {
  let resolve!:()=>void;
  const promise=new Promise<void>(done=>{resolve=done;});
  return {promise,resolve};
}
const hooks = {
  check() {}, stop() {}, async cleanKnowledge() {},
  lock<T>(run:(removeHistory:()=>void)=>Promise<T>) { return run(()=>{}); },
};
const confirm = {confirmName:'目标'};
test('归档项目清理穿透间接引用，保留混合记录、其他作用域和全局游标', async t => {
  const s = createStore(':memory:',true);
  t.after(()=>s.close());
  const purge = createProjectPurge(s);
  const target: [string,string,unknown][] = [
    ['eventbox.deliveries','delivery',{eventId:'durable'}],
    ['core.events','18',{type:'effects.changed',data:{id:'effect'}}],
    ['effects','run:r:start',{id:'effect',kind:'executor.start'}],
    ['effects','feishu-bot-send:'+JSON.stringify(['bot','app','out']),{kind:'channel.send'}],
    ['event.mailboxes','mail',{direction:'outbox',scope:{kind:'task',todoId:'t'},botId:'bot',eventKey:'out'}],
    ['eventbox.events','durable',{type:'todo.changed',data:{id:'t'}}],
    ['notifications.decision-sources','web-message:m',{createdAt:'today'}],
    ['dispatch-keys','retry','r'],['messages','m',{todoId:'t'}],
    ['runs','r',{id:'r',todoId:'t'}],['todos','t',{id:'t',projectId:'p'}],
    ['supervision.signals','sig',{runId:'r'}],
    ['plan-origins','plan',{projectId:'p'}],
    ['projects','p',{id:'p',name:'目标',archivedAt:'yesterday'}],
  ];
  for (const [c,k,v] of target) s.put(c,k,v);
  s.put('projects','peer',{id:'peer',name:'另一个项目'});
  s.put('todos','other',{id:'other',projectId:'peer',sourceMessageId:'m'});
  s.put('machines','r',{id:'r',name:'p'});
  s.put('core.event-metadata','lastId',18);
  s.put('plans','plan',{version:3,tasks:[{prompt:'隐含项目'}, {todoId:'other'}]});
  s.put('supervisor.reviews','mixed',{id:'mixed',signalIds:['sig','other-signal'],runIds:['r'],text:'混合内容'});
  s.put('background.briefs','brief',{facts:{projects:[{projectId:'p'},{projectId:'peer'}]}});
  await purge.purge('p',confirm,hooks);
  for (const [c,k] of target) assert.equal(s.get(c,k),undefined,c+'/'+k);
  assert.deepEqual(s.get('plans','plan'),{version:4,tasks:[{todoId:'other'}]});
  assert.deepEqual(s.get('background.briefs','brief'),{facts:{projects:[{projectId:'peer'}]}});
  const review = s.get<{signalIds:string[];text:string}>('supervisor.reviews','mixed')!;
  assert.deepEqual(review.signalIds,['other-signal']); assert.notEqual(review.text,'混合内容');
  assert.deepEqual(s.get('todos','other'),{id:'other',projectId:'peer',sourceMessageId:'m'});
  assert.ok(s.get('projects','peer')); assert.ok(s.get('machines','r')); assert.equal(s.get('core.event-metadata','lastId'),18);
  assert.throws(()=>s.put('runs','r',{id:'r',output:'迟到'}),{status:409});
});

test('知识清理失败后重启保留归属凭据，事务失败可重试；在途写入被拒绝', async t => {
  const dir = await mkdtemp(join(tmpdir(),'mario-purge-store-'));
  t.after(()=>rm(dir,{recursive:true,force:true}));
  const path = join(dir,'purge.sqlite');
  let s = createStore(path,true);
  let p = createProjectPurge(s);
  s.put('projects','p',{id:'p',name:'目标'});
  s.put('knowledge.sources','j',{projectId:'p'});
  s.put('knowledge.retry-requests','req',{jobId:'j'});
  const gate = deferred();
  const started = deferred();
  const attempt = p.purge('p',confirm,{...hooks,async cleanKnowledge(){
    s.remove('knowledge.sources','j'); started.resolve(); await gate.promise; throw Error('临时失败');
  }});
  await started.promise;
  await assert.rejects(p.purge('p',confirm,hooks),{status:409});
  assert.throws(()=>s.put('knowledge.retry-requests','late',{jobId:'j'}),{status:409});
  s.put('messages','global',{id:'global'});
  gate.resolve(); await assert.rejects(attempt,/临时失败/);
  s.close(); s=createStore(path,true); t.after(()=>s.close()); p=createProjectPurge(s);
  assert.throws(()=>s.put('knowledge.sources','j',{projectId:'peer'}),{status:409});
  const remove=s.remove;
  s.remove=(c,id)=>{if(c==='knowledge.retry-requests') throw Error('模拟 SQLite 失败'); return remove(c,id);};
  await assert.rejects(p.purge('p',confirm,hooks),/模拟 SQLite 失败/);
  assert.ok(s.get('projects','p')); assert.ok(s.get('core.pending-project-purges','p'));
  s.remove=remove;
  await p.purge('p',confirm,hooks);
  assert.ok(s.get('messages','global'));
  assert.equal(s.get('knowledge.retry-requests','req'),undefined);
  assert.equal(s.get('core.pending-project-purges','p'),undefined);
});

test('HTTP 按精确归属清理 task、交互与旧会话绑定，核验节点回执后提交', async t => {
  const root=await mkdtemp(join(tmpdir(),'mario-purge-node-'));
  const token='fixture-secret', machineId='fixture';
  const server=await startServer({host:'127.0.0.1',port:0,dataDir:join(root,'server'),token,demo:true});
  t.after(async()=>{await server.close();await rm(root,{recursive:true,force:true});});
  const post=async(id:string)=>fetch(server.url+'/api/v1/projects/'+id+'/purge',{method:'POST',headers:{authorization:'Bearer '+token,'content-type':'application/json'},body:JSON.stringify(confirm)});
  const p=await server.app.createProject({name:'目标'});
  const peer=await server.app.createProject({name:'对照'});
  const s=server.app.store;
  const records=['task','interactive',undefined].map((executionMode,index)=>({id:randomUUID(),sessionId:randomUUID(),machineId,executionMode,
    projectId:p.id,executorId:[machineId+'/codex',machineId+'/claude-code','pi'][index],status:'completed'}));
  for(const r of records) s.put('runs',r.id,r);
  assert.equal((await post(p.id)).status,409);
  let wrong=true;
  const calls:unknown[]=[];
  const node=startAgentNode({url:server.url,token,machineId,name:'fixture',dataDir:join(root,'node'),handlers:{
    'workspace.executor.purge': async params=>{calls.push(params); return {projectId:params.projectId,runId:params.runId,sessionId:wrong?'other':params.sessionId,purged:true};}
  }});
  t.after(()=>node.close());
  for(let i=0;i<100&&!server.machines.list().some(m=>m.id===machineId&&m.online);i++) await delay(15);
  const duplicate={...records[0],id:'duplicate',projectId:peer.id};
  s.put('runs',duplicate.id,duplicate);
  assert.equal((await post(p.id)).status,409);assert.deepEqual(calls,[]);
  s.remove('runs',duplicate.id);
  assert.equal((await post(p.id)).status,409);assert.ok(s.get('projects',p.id));assert.equal(calls.length,1);
  wrong=false;
  const done=await post(p.id);assert.equal(done.status,200,await done.text());
  assert.deepEqual(calls.slice(1),records.map(r=>({projectId:p.id,runId:r.id,sessionId:r.sessionId,status:r.status})));
  assert.ok(s.get('projects',peer.id)); assert.equal(s.get('projects',p.id),undefined);
});

test('全局简报保留其他项目并使含已删内容的发件授权失效', async t=>{
  const s=createStore(':memory:',true);t.after(()=>s.close());
  const p=createProjectPurge(s);
  s.put('projects','p',{id:'p',name:'目标'});
  s.put('projects','q',{id:'q',name:'对照'});
  const facts=(projectId:string,name:string)=>({projectId,name,progress:[],todoUpdates:[],completed:[],ended:[],failed:[],decisions:[]});
  s.put('background.briefs','window',{facts:{from:'a',to:'b',projects:[facts('p','目标'),facts('q','对照')]}});
  s.put('outbox.items','brief',{id:'brief',owner:'daily-brief',causedBy:'window',content:{text:'目标及对照'},approvalId:'a',version:1,status:'needs_approval'});
  s.put('approvals','a',{id:'a',params:{outboxId:'brief',text:'目标及对照'}});
  await p.purge('p',confirm,hooks);
  const item=s.get<{status:string;content:{text:string};approvalId?:string}>('outbox.items','brief')!;
  assert.match(item.content.text,/对照/);assert.doesNotMatch(item.content.text,/目标/);
  assert.equal(item.status,'cancelled');assert.equal(item.approvalId,undefined);assert.equal(s.get('approvals','a'),undefined);
});

test('离线时可清理普通项目，外部执行器和原生线程号不构成托管绑定', async t=>{
  const s=createStore(':memory:',true);t.after(()=>s.close()); const p=createProjectPurge(s);
  s.put('projects','p',{id:'p',name:'目标',workspace:{machineId:'offline',cwd:'/user/project'}});
  s.put('runs','external',{id:'external',projectId:'p',machineId:'offline',sessionId:randomUUID(),executorId:'external',executionMode:'interactive',status:'completed'});
  s.put('runs','native',{id:'native',projectId:'p',machineId:'offline',nativeSessionId:'original',executorId:'offline/codex',status:'completed'});
  assert.deepEqual(await p.purge('p',confirm,hooks),{purged:true});
});

test('节点已确认的清理跨重启保留回执，重试可离线完成 SQLite 提交', async t=>{
  const dir=await mkdtemp(join(tmpdir(),'mario-purge-receipt-')); t.after(()=>rm(dir,{recursive:true,force:true}));
  const path=join(dir,'data.sqlite'); let s=createStore(path,true); let p=createProjectPurge(s);
  const projectId='p',runId='r',sessionId=randomUUID();
  s.put('projects',projectId,{id:projectId,name:'目标'});
  s.put('runs',runId,{id:runId,projectId,sessionId,executorId:'fixture/codex',machineId:'fixture',status:'completed'});
  let calls=0;
  await assert.rejects(p.purge(projectId,confirm,{...hooks,machines:{
    list:()=>[{id:'fixture',name:'fixture',online:true,capabilities:['workspace.executor.purge'],executors:[],platform:'linux',connectedAt:''}],
    async call(){calls++;return {projectId,runId,sessionId,purged:true};}
  },async cleanKnowledge(){throw Error('知识库待重试');}}),/知识库待重试/);
  s.close();s=createStore(path,true);t.after(()=>s.close());p=createProjectPurge(s);
  await p.purge(projectId,confirm,hooks);assert.equal(calls,1);assert.equal(s.get('projects',projectId),undefined);
});
