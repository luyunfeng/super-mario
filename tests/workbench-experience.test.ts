import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, symlink, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { workspaceCode } from '../plugins/workspace-code.ts';
import { createWebPresence } from '../packages/core/src/web-presence.ts';
import { buildWindowBrief, createBriefingSettings } from '../packages/core/src/briefing.ts';
import { createAwayNotifications } from '../packages/core/src/away-notifications.ts';
import { createStore } from '../packages/core/src/store.ts';
import { createEventBus } from '../packages/core/src/events.ts';
import { createEffects } from '../packages/core/src/effects.ts';
import { createBackground } from '../packages/core/src/background.ts';
import { startServer } from '../apps/server/src/index.ts';
import { startAgentNode } from '../apps/agent-node/src/index.ts';
import { createProjectDiscovery } from '../plugins/project-discovery.ts';
import type { FeishuBot, Run, Todo, Project } from '../packages/protocol/src/index.ts';

const poll = async (fn:()=>boolean) => { for (let n=0;n<100;n++){if(fn())return; await new Promise(r=>setTimeout(r,20));}assert.fail('等待状态超时'); };
async function codeFixture(t: test.TestContext) {
  const dir=await mkdtemp(join(tmpdir(),'mario-code-')),root=join(dir,'repo');await mkdir(root);
  const cleanups: Array<()=>Promise<unknown>>=[];t.after(async()=>{for(const clean of cleanups.reverse())await clean();await rm(dir,{recursive:true,force:true});});
  const git=(args:string[])=>execFileSync('git',args,{cwd:root,env:{PATH:process.env.PATH,HOME:dir,GIT_CONFIG_NOSYSTEM:'1'}});
  git(['init','-q']);await writeFile(join(root,'hello.ts'),'export const hello = 1;\n');
  git(['add','hello.ts']);git(['-c','user.name=Test','-c','user.email=test@localhost','commit','-qm','fixture']);
  await writeFile(join(root,'hello.ts'),'export const hello = 2;\n');
  const call=(kind:string,path='')=>workspaceCode({cwd:root,kind,path},()=>{});
  return {dir,root,call,cleanups};
}
test('代码：普通文本、目录与真实 Git diff；不读取服务端同名目录',async t=>{
  const f=await codeFixture(t);
  const tree=await f.call('tree') as {entries:{name:string}[]};assert.deepEqual(tree.entries.map(e=>e.name),['hello.ts']);
  assert.match((await f.call('file','hello.ts') as {text:string}).text,/hello = 2/);
  assert.match((await f.call('diff','hello.ts') as {text:string}).text,/-export const hello = 1/);
  const outside=join(f.dir,'outside.txt');await writeFile(outside,'outside');
  await symlink(outside,join(f.root,'escape'));await symlink(f.dir,join(f.root,'outside-dir'));
  for(const path of ['../outside.txt','escape','outside-dir/outside.txt','/etc/passwd']) await assert.rejects(f.call('file',path));
  await symlink(f.root,join(f.dir,'root-alias'));await assert.rejects(workspaceCode({cwd:join(f.dir,'root-alias'),kind:'tree'},()=>{}),/根目录已变化/);
  await assert.rejects(workspaceCode({cwd:'/',kind:'tree'},()=>{}),/根目录/);
});
test('代码：敏感文件及其别名、二进制、UTF-8、大文件和非仓库边界',async t=>{
  const f=await codeFixture(t);
  for (const name of ['.env','.env.local','credentials.json','id_rsa','private.pem']) {await writeFile(join(f.root,name),'secret');await assert.rejects(f.call('file',name),/敏感/);}
  await symlink(join(f.root,'.env'),join(f.root,'alias.txt'));await assert.rejects(f.call('file','alias.txt'),/敏感/);
  await writeFile(join(f.root,'binary'),Buffer.from([0,12,1]));await assert.rejects(f.call('file','binary'),/二进制/);await assert.rejects(f.call('diff','binary'),/二进制/);
  await writeFile(join(f.root,'invalid'),Buffer.from([255,254]));await assert.rejects(f.call('file','invalid'),/UTF-8/);
  await writeFile(join(f.root,'large'),'a'.repeat(256*1024+1));await assert.rejects(f.call('file','large'),/过大/);
  await mkdir(join(f.root,'child'));await writeFile(join(f.root,'child','a.txt'),'child');
  await assert.rejects(workspaceCode({cwd:join(f.root,'child'),kind:'diff',path:'a.txt'},()=>{}),/Git 项目根目录/);
});
test('Git diff 不执行项目配置的 clean/process/textconv 程序',async t=>{
  const f=await codeFixture(t),marker=join(f.dir,'executed');
  await writeFile(join(f.root,'.gitattributes'),'hello.ts filter=untrusted diff=untrusted\n');
  const git=(args:string[])=>execFileSync('git',args,{cwd:f.root});
  git(['config','filter.untrusted.clean',`touch ${marker}`]);git(['config','filter.untrusted.process',`touch ${marker}`]);git(['config','filter.untrusted.required','true']);git(['config','diff.untrusted.textconv',`touch ${marker}`]);
  assert.match((await f.call('diff','hello.ts') as {text:string}).text,/hello = 2/);await assert.rejects(readFile(marker));
});
test('在场：多标签、隐藏、失焦、乱序心跳、租约失效和重启',()=>{
  let time=0;const p=createWebPresence(()=>time);
  p.heartbeat({tabId:'tab-one-000',visible:true,focused:true,sequence:1});
  p.heartbeat({tabId:'tab-two-000',visible:false,focused:false});assert.equal(p.status().present,true);
  p.heartbeat({tabId:'tab-one-000',visible:false,focused:false,sequence:3});
  p.heartbeat({tabId:'tab-one-000',visible:true,focused:true,sequence:2});assert.equal(p.status().present,false);
  p.heartbeat({tabId:'tab-two-000',visible:true,focused:true});assert.equal(p.status().present,true);
  time=45001;assert.deepEqual(p.status(),{present:false,tabs:0,leaseMs:45000});
  assert.equal(createWebPresence().status().present,false);
  assert.throws(()=>p.heartbeat({tabId:'../bad',visible:true,focused:true}));
});
function backend(t:test.TestContext) {
  const store=createStore(':memory:'),events=createEventBus(store),effects=createEffects({store,events});
  const bg=createBackground({store,events,effects,propose:()=>{throw new Error('本测试不授权外发');}});
  const cleanups: Array<()=>Promise<unknown>>=[];t.after(async()=>{for(const clean of cleanups.reverse())await clean();await bg.close();await effects.close();store.close();});return {store,bg,cleanups};
}
function bot(id:string,scope:FeishuBot['scope']):FeishuBot {return {id,name:id,appId:'app-'+id,scope,enabled:true,configured:true,connected:true,paired:true,replyTarget:'owner-'+id,requireConfirmation:true,createdAt:'',updatedAt:''};}
for (const level of ['task','project','global','unpaired'] as const) test(`离场路由：${level} 优先级、积压恢复、替身投递去重、授权不变`,async t=>{
  const {store,bg,cleanups}=backend(t);const presence=createWebPresence();
  const all=[bot('task',{kind:'task',todoId:'todo'}),bot('project',{kind:'project',projectId:'p'}),bot('global',{kind:'global'})];
  let bots=level==='unpaired'?[]:all.slice(['task','project','global'].indexOf(level));
  let sends=0;
  const channel=(b:FeishuBot)=>{const ch=`feishu.bot:${b.id}:0123456789abcdef`;bg.outbox.registerChannel(ch,async()=>{sends++;},()=>b.replyTarget);return ch;};
  const service=createAwayNotifications({store,background:bg,presence,bots:()=>bots,channel});cleanups.push(()=>service.close());
  store.put('runs','r',{id:'r',projectId:'p',todoId:'todo'});
  const publish=()=>bg.publish({type:'run.finished',typeVersion:1,sourceId:'r-finished',data:{runId:'r'}});
  publish();publish();await bg.eventbox.drain();assert.equal(service.list().length,1);
  if(level==='unpaired'){assert.match(service.list()[0].reason!,/积压/);assert.equal(bg.outbox.list().length,0);bots=[all[2]];service.flush();}
  const out=bg.outbox.list()[0];assert.match(out.channel,new RegExp(`:${level==='unpaired'?'global':level}:`));
  assert.equal(sends,0);assert.deepEqual(bg.outbox.grants(),[]);
  // An isolated test-only authorization reaches a fake sender, never a real channel.
  bg.outbox.grant('away-notifications',out.channel,true);await bg.outbox.tick();await bg.outbox.tick();assert.equal(sends,1);
  publish();await bg.eventbox.drain();service.flush();await bg.outbox.tick();assert.equal(sends,1);
});
test('离场：在场不通知、未标记机器人不兜底、已答问题不再积压',async t=>{
  const {store,bg,cleanups}=backend(t),presence=createWebPresence();let bots=[bot('unmarked',{kind:'unmarked'})];
  const service=createAwayNotifications({store,background:bg,presence,bots:()=>bots,channel:()=>{throw new Error('不能路由到未标记机器人');}});cleanups.push(()=>service.close());
  presence.heartbeat({tabId:'visible-tab',visible:true,focused:true});
  bg.publish({type:'run.finished',typeVersion:1,sourceId:'present',data:{}});await bg.eventbox.drain();assert.equal(service.list()[0].status,'skipped');
  presence.heartbeat({tabId:'visible-tab',visible:false,focused:false});store.put('interactions','c',{id:'c',status:'open'});
  bg.publish({type:'interaction.user_required',typeVersion:1,sourceId:'away',data:{id:'c'}});await bg.eventbox.drain();assert.equal(service.list().find(n=>n.cardId==='c')!.status,'pending');
  store.put('interactions','c',{id:'c',status:'answered'});service.flush();assert.equal(service.list().find(n=>n.cardId==='c')!.status,'skipped');assert.equal(bg.outbox.list().length,0);
});
test('时间窗摘要：项目进展、待办完成、执行结束、失败、待决定和边界',t=>{
  const {store}=backend(t);const from='2026-11-17T00:00:00Z',to='2026-11-17T04:00:00Z';
  store.put('projects','p',{id:'p',name:'项目 A'} satisfies Partial<Project>);
  const run={id:'progress',projectId:'p',prompt:'推进工作',status:'running',updatedAt:'2026-11-17T01:00:00Z',output:''} satisfies Partial<Run>;
  for(const [id,status,date] of [['progress','running','01'],['done','completed','02'],['bad','failed','03'],['old','failed','00']] as const)store.put('runs',id,{...run,id,status,updatedAt:`2026-11-17T${date}:00:00Z`});
  store.put('todos','done',{id:'done',projectId:'p',title:'已验收',completedAt:to,updatedAt:to} satisfies Partial<Todo>);
  store.put('interactions','decision',{id:'decision',projectId:'p',status:'open',title:'待批准',createdAt:'2026-11-16T00:00:00Z'});
  const brief=buildWindowBrief(store,from,to),p=brief.projects[0];assert.equal(p.progress.length,1);assert.equal(p.completed.length,1);assert.equal(p.ended.length,1);assert.equal(p.failed.length,1);assert.equal(p.decisions.length,1);
  assert.equal(buildWindowBrief(store,to,'2026-11-17T08:00:00Z').projects[0].completed.length,0);
});
test('简报配置：保留已有任务和暂停状态，间隔启停复用、不重复，时区时段校验',t=>{
  const {store,bg}=backend(t),s=bg.schedules.forOwner('daily-brief');const existing=s.create({name:'morning',kind:'cron',cron:'0 9 * * *',tz:'Asia/Shanghai'});
  s.update(existing.id,{status:'paused'},existing.version);const custom=s.create({name:'my-existing',kind:'interval',everySec:3600});
  const config=createBriefingSettings(store,bg.schedules);config.configure({intervalEnabled:true,morning:'08:30',timezone:'America/Los_Angeles'});
  assert.equal(s.list().find(i=>i.id===existing.id)!.status,'paused');assert.deepEqual(s.list().find(i=>i.id===custom.id),custom);
  const interval=s.list().find(i=>i.name==='interval')!;config.configure({intervalEnabled:false});config.configure({intervalEnabled:true,intervalHours:2});assert.equal(s.list().find(i=>i.name==='interval')!.id,interval.id);assert.equal(s.list().filter(i=>i.name==='interval').length,1);
  assert.equal(config.inActiveWindow('2026-11-17T18:00:00Z'),true);assert.equal(config.inActiveWindow('2026-11-17T09:00:00Z'),false);
  assert.throws(()=>config.configure({intervalHours:0}));assert.throws(()=>config.configure({timezone:'bad/zone'}));assert.throws(()=>config.configure({activeStart:'22:00',activeEnd:'08:00'}));
});
test('隔离 HTTP / WS 代理：绑定目录读取、认证、离线失败及摘要幂等',async t=>{
  const f=await codeFixture(t);const server=await startServer({host:'127.0.0.1',port:0,dataDir:join(f.dir,'data'),demo:true,token:'isolated-workbench-test'});f.cleanups.push(()=>server.close());
  const node=startAgentNode({url:server.url,token:'isolated-workbench-test',machineId:'remote-computer',name:'隔离电脑',dataDir:join(f.dir,'node'),handlers:createProjectDiscovery({home:f.dir}).handlers});f.cleanups.push(()=>node.close());
  await poll(()=>server.machines.list().some(m=>m.online));
  const headers={'Authorization':'Bearer isolated-workbench-test','Content-Type':'application/json'};
  const api=async(path:string,method='GET',body?:unknown)=>{const res=await fetch(server.url+'/api/v1'+path,{method,headers,...(body?{body:JSON.stringify(body)}:{})});return {status:res.status,data:await res.json()};};
  const p=await api('/projects','POST',{name:'远端项目',workspace:{machineId:'remote-computer',cwd:f.root}});assert.equal(p.status,201);
  assert.equal((await api(`/projects/${p.data.id}/code?kind=file&path=hello.ts`)).data.text,'export const hello = 2;\n');
  assert.equal((await fetch(server.url+`/api/v1/projects/${p.data.id}/code`)).status,401);
  assert.equal((await api('/presence','POST',{tabId:'http-tab-000',visible:true,focused:true})).data.present,true);
  assert.equal((await api('/briefing/settings','PUT',{intervalHours:0})).status,400);
  const morning=server.app.background.schedules.list().find(s=>s.name==='morning')!;
  const due=new Date().toISOString();server.app.store.put('eventbox.schedules',morning.id,{...morning,nextAt:due});
  await server.app.background.tick();await server.app.background.eventbox.drain();await server.app.background.tick();await server.app.background.eventbox.drain();
  assert.equal(server.app.store.list('background.briefs').length,1);assert.equal(server.app.background.outbox.list().filter(i=>i.owner==='daily-brief').length,1);
  assert.deepEqual(server.app.background.outbox.grants(),[]);
  await node.close();await poll(()=>!server.machines.list().some(m=>m.online));assert.equal((await api(`/projects/${p.data.id}/code`)).status,503);
});

test('HTTP 替身飞书：离场问题经原审批只投递一次；机器人改绑拒绝旧通知',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'mario-away-bot-'));
  let uncertain=false;
  const adapters: Array<{options:import('../plugins/feishu.ts').FeishuOptions;sent:string[]}> = [];
  const server=await startServer({host:'127.0.0.1',port:0,dataDir:dir,demo:true},{botFactory:options=>{
    const item={options,sent:[] as string[]};adapters.push(item);
    return {async start(){},async close(){},async send(target,text){item.sent.push(target+':'+text);if(uncertain)throw new Error('隔离网络结果未知');},async collect(){return [];},status:()=>({connected:true})};
  }});
  const api=async(path:string,method='GET',input?:unknown)=>{const r=await fetch(server.url+'/api/v1'+path,{method,headers:{'Content-Type':'application/json'},...(input?{body:JSON.stringify(input)}:{})});const data=await r.json();assert.ok(r.ok,JSON.stringify(data));return data;};
  try {
    const b=await api('/feishu/bots','POST',{name:'隔离全局机器人',appId:'cli_1111222233334444',appSecret:'isolated-only-fake-secret',scope:{kind:'global'},requireConfirmation:true});
    await adapters[0].options.onMessage(b.pairingCode,{messageId:'pair',chatId:'fake-owner',senderId:'fake-human',chatType:'p2p'});adapters[0].sent=[];
    const publish=async(id:string)=>{
      server.app.store.put('interactions',id,{id,kind:'question',status:'open',title:'需要决定',createdAt:new Date().toISOString()});
      server.app.store.put('messages',id,{id,text:'隔离待决定消息'});
      server.app.background.publish({type:'interaction.user_required',typeVersion:1,sourceId:id,data:{id,messageId:id}});
      await server.app.background.eventbox.drain();await server.app.background.outbox.tick();
      return server.app.background.outbox.list().find(i=>i.owner==='away-notifications'&&i.content.text==='隔离待决定消息'&&i.status==='needs_approval')!;
    };
    const first=await publish('first');assert.ok(first,JSON.stringify({notices:server.app.awayNotifications.list(),outbox:server.app.background.outbox.list().map(i=>({status:i.status,error:i.error,text:i.content.text})),bots:await api('/feishu/bots')}));assert.equal(adapters[0].sent.length,0);assert.deepEqual(server.app.background.outbox.grants(),[]);
    const a=server.app.approvals.list().find(a=>a.id===first.approvalId)!;await server.app.approvals.approve(a.id,a.version);await server.app.background.outbox.tick();assert.equal(adapters[0].sent.length,1);
    server.app.awayNotifications.flush();await server.app.background.outbox.tick();assert.equal(adapters[0].sent.length,1);
    const second=await publish('second');assert.ok(second);
    await api('/feishu/bots/'+b.id,'PATCH',{name:'绑定已变更'});
    const approval=server.app.approvals.list().find(a=>a.id===second.approvalId)!;await server.app.approvals.approve(approval.id,approval.version);await server.app.background.outbox.tick();
    assert.equal(adapters.reduce((n,a)=>n+a.sent.length,0),1);assert.ok(['held','queued'].includes(server.app.background.outbox.list().find(i=>i.id===second.id)!.status));assert.deepEqual(server.app.background.outbox.grants(),[]);
    server.app.background.publish({type:'schedule.due',typeVersion:1,sourceId:'fake-bot-brief',data:{owner:'daily-brief',name:'morning',scheduleId:'fake-schedule',scheduledFor:new Date().toISOString()}});
    await server.app.background.eventbox.drain();await server.app.background.outbox.tick();
    const brief=server.app.background.outbox.list().find(i=>i.owner==='daily-brief')!;assert.match(brief.channel,new RegExp(':'+b.id+':'));
    const briefApproval=server.app.approvals.list().find(a=>a.id===brief.approvalId)!;await server.app.approvals.approve(briefApproval.id,briefApproval.version);assert.equal(adapters.reduce((n,a)=>n+a.sent.length,0),2);
    uncertain=true;const unknown=await publish('unknown');const unknownApproval=server.app.approvals.list().find(a=>a.id===unknown.approvalId)!;await server.app.approvals.approve(unknownApproval.id,unknownApproval.version);
    await server.app.background.outbox.tick();await server.app.background.outbox.tick();assert.equal(adapters.reduce((n,a)=>n+a.sent.length,0),3);assert.equal(server.app.background.outbox.list().find(i=>i.id===unknown.id)!.status,'unknown');

  } finally {await server.close();await rm(dir,{recursive:true,force:true});}
});

test('隔离间隔调度：时间窗与项目事实、静默时段、防重复及游标持久化',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'mario-brief-window-'));
  let server=await startServer({host:'127.0.0.1',port:0,dataDir:dir,demo:true});
  try {
    const original=server.app.background.schedules.list();
    server.app.briefing.configure({intervalEnabled:true,intervalHours:2});
    for(const schedule of original)assert.deepEqual(server.app.background.schedules.list().find(s=>s.id===schedule.id),schedule);
    server.app.briefing.configure({timezone:'UTC',activeStart:'09:00',activeEnd:'21:00'});
    const schedule=server.app.background.schedules.list().find(s=>s.name==='interval')!;
    const emit=async(source:string,to:string)=>{server.app.background.publish({type:'schedule.due',typeVersion:1,sourceId:source,data:{owner:'daily-brief',name:'interval',scheduleId:schedule.id,scheduledFor:to}});await server.app.background.eventbox.drain();};
    server.app.store.put('projects','a',{id:'a',name:'A'});server.app.store.put('todos','a-todo',{id:'a-todo',projectId:'a',title:'完成验收',completedAt:'2026-11-17T10:00:00Z',updatedAt:'2026-11-17T10:00:00Z'});
    await emit('off-hours','2026-11-17T08:00:00Z');assert.equal(server.app.store.list('background.briefs').length,0);
    await emit('window1','2026-11-17T11:00:00Z');await emit('duplicate-other-source','2026-11-17T11:00:00Z');assert.equal(server.app.store.list('background.briefs').length,1);
    assert.match(server.app.background.outbox.list()[0].content.text,/待办完成 1：完成验收/);
    await server.close();server=await startServer({host:'127.0.0.1',port:0,dataDir:dir,demo:true});
    await emit('window2','2026-11-17T13:00:00Z');const records=server.app.store.list<{facts:{from:string;to:string;projects:{completed:unknown[]}[]}}>('background.briefs');
    assert.equal(records.length,2);const next=records.find(r=>r.facts.to==='2026-11-17T13:00:00Z')!;assert.equal(next.facts.from,'2026-11-17T11:00:00Z');assert.equal(next.facts.projects[0].completed.length,0);
    assert.deepEqual(server.app.background.outbox.grants(),[]);
  } finally {await server.close();await rm(dir,{recursive:true,force:true});}
});

test('主对话结果与审批/计划：离场积压、重复事件、已处理失效和通知审批不递归',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'mario-web-decisions-'));
  const server=await startServer({host:'127.0.0.1',port:0,dataDir:dir,demo:true});
  try {
    const now=new Date().toISOString();
    server.app.store.put('messages','answer',{id:'answer',conversationId:'main',role:'assistant',status:'done',replyTo:'input',text:'离场后的对话回答',createdAt:now});
    server.app.events.publish('messages.changed',{messageId:'answer'});server.app.events.publish('messages.changed',{messageId:'answer'});
    const approval=server.app.approvals.propose({kind:'input',title:'需要批准',details:'隔离审批',params:{runId:'fake-run',text:'fake'}});
    const plan=await server.app.proposePlan({title:'待确认计划',tasks:[{prompt:'隔离检查',doneWhen:'本地通过',expectMinutes:1}]});
    await server.app.background.eventbox.drain();
    const notices=server.app.awayNotifications.list();assert.equal(notices.length,3);assert.ok(notices.every(n=>n.status==='pending'));assert.equal(notices.filter(n=>n.text==='离场后的对话回答').length,1);
    server.app.approvals.reject(approval.id,approval.version);server.app.plans.reject(plan.id,plan.version);server.app.awayNotifications.flush();
    assert.equal(server.app.awayNotifications.list().filter(n=>n.status==='skipped').length,2);
    const preview=server.app.supervision.brief() as {window:{projects:{decisions:{id:string}[]}[]}};
    assert.ok(!preview.window.projects.some(p=>p.decisions.some(d=>d.id===plan.id)));
    assert.deepEqual(server.app.background.outbox.grants(),[]);
  } finally {await server.close();await rm(dir,{recursive:true,force:true});}
});

test('返回 Web 或关闭离场通知会取消未发送积压，保留 unknown',async t=>{
  const {store,bg,cleanups}=backend(t),presence=createWebPresence();const b=bot('global',{kind:'global'});
  const service=createAwayNotifications({store,background:bg,presence,bots:()=>[b],channel:()=> 'feishu.bot:global:0123456789abcdef'});cleanups.push(()=>service.close());
  bg.publish({type:'run.finished',typeVersion:1,sourceId:'return-web',data:{}});await bg.eventbox.drain();const first=bg.outbox.list()[0];assert.ok(first);
  presence.heartbeat({tabId:'returned-web',visible:true,focused:true});service.flush();assert.equal(bg.outbox.list()[0].status,'cancelled');
  presence.heartbeat({tabId:'returned-web',visible:false,focused:false});bg.publish({type:'run.finished',typeVersion:1,sourceId:'disable-web',data:{}});await bg.eventbox.drain();
  const second=bg.outbox.list().find(o=>o.id!==first.id)!;bg.outbox.grant('away-notifications',second.channel,true);
  bg.outbox.registerChannel(second.channel,async()=>{throw new Error('unknown');},()=>b.replyTarget);await bg.outbox.tick();assert.equal(bg.outbox.list().find(o=>o.id===second.id)!.status,'unknown');
  store.put('notifications.settings','away',{enabled:false});service.flush();assert.equal(bg.outbox.list().find(o=>o.id===second.id)!.status,'unknown');
});
