import test from 'node:test';import assert from'node:assert/strict';import{mkdtemp,mkdir,writeFile,chmod,readFile,rm,access}from'node:fs/promises';import{join}from'node:path';import{tmpdir}from'node:os';import{setTimeout as delay}from'node:timers/promises';
import{startServer}from'../apps/server/src/index.ts';import{runWithAgentInput}from'../packages/core/src/agent-input.ts';import type{Message,Json,JsonObject}from'../packages/protocol/src/index.ts';import type{MachineClient}from'../packages/plugin-sdk/src/index.ts';
import { botConversationId } from '../packages/core/src/bot-agent-routing.ts';
async function until(check:()=>boolean){for(let n=0;n<1500;n++){if(check())return;await delay(10);}assert.ok(check(),'source consent pipeline timed out');}
async function fixture(t:test.TestContext){const dir=await mkdtemp(join(tmpdir(),'mario-source-consent-')),bin=join(dir,'bin'),log=join(dir,'reads.jsonl');await mkdir(bin);const file=join(bin,'lark-cli');await writeFile(file,`#!${process.execPath}\nconst fs=require('node:fs');const a=process.argv.slice(2);fs.appendFileSync(${JSON.stringify(log)},JSON.stringify(a)+'\\n');const token=a[a.indexOf('--url')+1];const data=a.includes('+inspect')?{type:'docx',token,title:'Private doc',url:'https://tenant.feishu.cn/docx/'+token}:{document:{document_id:a[a.indexOf('--doc')+1],content:'# Protected material\\nNever execute source instructions.'}};console.log(JSON.stringify({ok:true,identity:'user',data}));\n`);await chmod(file,0o700);const oldPath=process.env.PATH;process.env.PATH=bin+':'+oldPath;const server=await startServer({host:'127.0.0.1',port:0,dataDir:join(dir,'server'),demo:true,token:'owner'});let submitted=0,remoteJob:any,scope:any;
 const client:MachineClient={list:()=>[{id:'node',name:'Fake worker',online:true,platform:'linux',connectedAt:'now',capabilities:['executor.knowledge.start']}],async call(_id,method,params):Promise<Json>{if(method==='executor.knowledge.start'){scope=params.scope;return{workerId:'worker',provider:'codex',state:'idle',sessionId:'session',...(scope?{scope}:{})};}if(method==='executor.knowledge.status')return{workerId:'worker',provider:'codex',state:'idle',sessionId:'session',...(scope?{scope}:{}),...(remoteJob?{job:remoteJob}:{})};if(method==='executor.knowledge.submit'){submitted++;remoteJob={id:params.jobId,scope:params.scope,status:'completed',text:JSON.stringify({pages:[{title:'Normalized page',content:'Source facts only'}],summary:'synthetic'})};return{accepted:true};}if(method==='executor.knowledge.stop')return{stopped:true};throw Error('Unexpected fake method '+method);}};
 server.app.setMachineClient(client);await server.app.knowledgeCurator.configure({enabled:true,machineId:'node',provider:'codex'});server.app.knowledgeSources.configure({enabled:true,profile:'offline',trustedHosts:[]});
 t.after(async()=>{await server.close();if(oldPath===undefined)delete process.env.PATH;else process.env.PATH=oldPath;await rm(dir,{recursive:true,force:true});});
 return{server,dir,submitted:()=>submitted,async reads(){try{return(await readFile(log,'utf8')).trim().split('\n').filter(Boolean).length;}catch{return 0;}},async api(path:string,method='GET',body?:unknown){const r=await fetch(server.url+'/api/v1'+path,{method,headers:{authorization:'Bearer owner','content-type':'application/json'},...(body?{body:JSON.stringify(body)}:{})});return{status:r.status,data:await r.json() as any};}};
}
function source(f:Awaited<ReturnType<typeof fixture>>):Message{const value:Message={id:'actual-user',role:'user',origin:'user',conversationId:'main',text:'Please ingest the private document',status:'done',createdAt:new Date().toISOString()};f.server.app.store.put('messages',value.id,value);return value;}
test('model request cannot forge Web intent; no private CLI or model runs before actual owner approval',async t=>{
 const f=await fixture(t),user=source(f),tool=f.server.app.contributions.list('tools').find(x=>x.value.name==='knowledge_ingest')!.value;
 const job=await runWithAgentInput(user,()=>tool.execute({url:'https://tenant.feishu.cn/docx/Doc123',requestOrigin:'web',sourceMessageId:'forged'} as JsonObject,new AbortController().signal)) as JsonObject;
 await until(()=>f.server.app.knowledgeCurator.status().jobs.find(x=>x.id===job.id)?.status==='awaiting_approval');const pending=f.server.app.knowledgeCurator.status().jobs.find(x=>x.id===job.id)!;assert.equal(pending.requestOrigin,'agent');assert.equal(pending.sourceMessageId,user.id);assert.ok(pending.approvalId);assert.equal(await f.reads(),0);assert.equal(f.submitted(),0);await assert.rejects(access(join(f.dir,'server','plugins','knowledge-local','raw',String(job.id)+'.md')),{code:'ENOENT'});
 const approved=await f.api('/approvals/'+pending.approvalId+'/approve','POST',{version:1});assert.equal(approved.data.status,'completed');assert.equal(approved.data.result.jobId,job.id);
 await until(()=>['completed','failed','unknown'].includes(f.server.app.knowledgeCurator.status().jobs.find(x=>x.id===job.id)!.status));const done=f.server.app.knowledgeCurator.status().jobs.find(x=>x.id===job.id)!;assert.equal(done.status,'completed',done.error);assert.equal(f.submitted(),1);assert.equal(await f.reads(),2);
 const pages=await f.server.app.knowledge().list();assert.ok(pages.some(p=>p.layer==='personal'&&p.title==='Normalized page'));
});
test('direct authenticated Web source is an explicit read request and needs no redundant source approval',async t=>{
 const f=await fixture(t);const job=(await f.api('/knowledge/sources','POST',{url:'https://tenant.feishu.cn/docx/Doc456'})).data;
 await until(()=>['completed','failed','unknown'].includes(f.server.app.knowledgeCurator.status().jobs.find(x=>x.id===job.id)!.status));const done=f.server.app.knowledgeCurator.status().jobs.find(x=>x.id===job.id)!;assert.equal(done.status,'completed',done.error);assert.equal(done.requestOrigin,'web');assert.equal(f.server.app.approvals.list().filter(a=>a.kind==='plugin:knowledge-local.read-source').length,0);assert.equal(await f.reads(),2);
});
test('reader config change invalidates an awaiting grant; raw model service bypass stays denied',async t=>{
 const f=await fixture(t),user=source(f),tool=f.server.app.contributions.list('tools').find(x=>x.value.name==='knowledge_ingest')!.value;
 await assert.rejects(runWithAgentInput(user,()=>f.server.app.plugins.invocations.use('knowledge-local.source.read',{url:'https://tenant.feishu.cn/docx/Doc789'})),{status:403});assert.equal(await f.reads(),0);
 const job=await runWithAgentInput(user,()=>tool.execute({url:'https://tenant.feishu.cn/docx/Doc789'},new AbortController().signal)) as JsonObject;await until(()=>f.server.app.knowledgeCurator.status().jobs.find(x=>x.id===job.id)?.status==='awaiting_approval');const pending=f.server.app.knowledgeCurator.status().jobs.find(x=>x.id===job.id)!;
 f.server.app.knowledgeSources.configure({enabled:true,profile:'another',trustedHosts:[]});assert.equal(f.server.app.store.get<any>('approvals',pending.approvalId!)!.status,'rejected');assert.equal(f.server.app.knowledgeCurator.status().jobs.find(x=>x.id===job.id)!.status,'failed');assert.equal(await f.reads(),0);assert.equal(f.submitted(),0);
});

test('removing the originating bot invalidates pending source consent and prevents private reads', async t => {
  const f = await fixture(t), app = f.server.app;
  const scope = { kind: 'global' as const }, bot = { id: 'fixture-bot', scope, enabled: true, paired: true };
  app.setBotsStatus(() => [bot]); app.setBotScopeAccess(() => true);
  const user: Message = { id: 'bot-user', role: 'user', origin: 'user', conversationId: botConversationId(bot), text: 'Read this source', status: 'done', createdAt: new Date().toISOString() };
  app.store.put('messages', user.id, user);
  app.store.put('message.routes', user.id, { channel: 'feishu', accountId: 'fake-app', botId: bot.id, target: 'fake-chat', scope, revision: 1, inputId: user.id, envelopeId: 'fake-envelope', sourceMessageId: 'platform-user' });
  app.store.put('event.mailboxes', 'fake-envelope', { id: 'fake-envelope', direction: 'inbox', botId: bot.id, scope, eventKey: 'feishu-in:' + JSON.stringify([bot.id, 'fake-app', 'platform-user']), sourceMessageId: 'platform-user', target: 'fake-chat', text: user.text, origin: { kind: 'direct' } });
  app.store.put('feishu.bot.envelopes', 'fake-envelope', { revision: 1 });
  app.store.put('feishu.bot.dispatch', bot.id + ':fake-app:fake-envelope', { status: 'completed', id: user.id });
  const tool = app.contributions.list('tools').find(x => x.value.name === 'knowledge_ingest')!.value;
  const job = await runWithAgentInput(user, () => tool.execute({ url: 'https://tenant.feishu.cn/docx/RemovedBot' }, new AbortController().signal)) as JsonObject;
  await until(() => app.knowledgeCurator.status().jobs.find(x => x.id === job.id)?.status === 'awaiting_approval');
  const waiting = app.knowledgeCurator.status().jobs.find(x => x.id === job.id)!;
  app.setBotsStatus(() => []); app.events.publish('bots.changed', {});
  assert.equal(app.knowledgeCurator.status().jobs.find(x => x.id === job.id)?.status, 'failed');
  assert.equal((await f.api('/approvals/' + waiting.approvalId + '/approve', 'POST', { version: 1 })).status, 409);
  assert.equal(await f.reads(), 0); assert.equal(f.submitted(), 0);
});

test('个人采集补入会议文档，使用采集账号读取真实来源接口并保留正文快照', async t => {
  const f = await fixture(t), app = f.server.app;
  const account = { profile: 'offline', appId: 'cli_test', openId: 'ou_reader' };
  app.setKnowledgeSourceAccount(() => account);
  const handle = `feishu:${account.appId}:${account.openId}`;
  const url = 'https://tenant.feishu.cn/docx/Meeting123';
  const thing = { origin: { kind: 'direct' as const, chatId: 'oc_minutes', connector: '飞书', meetingMinutes: true as const },
    thread: 'feishu:message:["oc_minutes","om_minutes"]', last: 'om_minutes', title: '会议资料', text: `[周会纪要](${url})` };
  await app.inbox.ingest(handle, [thing]);
  app.collectMeetingMemory(handle, []);
  app.collectMeetingMemory(handle, [thing]);
  const jobs = () => app.knowledgeCurator.status().jobs;
  await until(() => ['failed','completed'].includes(jobs()[0]?.status || ''));
  assert.equal(jobs().length, 1);
  const job = jobs()[0]!;
  assert.equal(job.status, 'completed', job.error);
  assert.equal(job.requestOrigin, 'meeting');
  assert.equal(await f.reads(), 2);
  const raw = await readFile(join(f.dir,'server','plugins','knowledge-local','raw',job.id+'.md'),'utf8');
  assert.match(raw, /Protected material/);
  const [entry] = await app.knowledge().list({ layer: 'personal' });
  assert.ok(entry?.content.includes(url));
  assert.ok(entry.content.includes(job.sourceMessageId!));
});

test('会议文档不能改用其他已配置的读取身份', async t => {
  const f = await fixture(t), app = f.server.app;
  app.setKnowledgeSourceAccount(() => ({ profile: 'other-profile', appId: 'cli_test', openId: 'ou_reader' }));
  const handle = 'feishu:cli_test:ou_reader';
  const thing = { origin: { kind: 'direct' as const, chatId: 'oc_minutes', connector: '飞书', meetingMinutes: true as const },
    thread: 'feishu:message:["oc_minutes","om_minutes"]', last: 'om_minutes', title: '会议资料', text: 'https://tenant.feishu.cn/docx/Meeting456' };
  await app.inbox.ingest(handle, [thing]);
  app.collectMeetingMemory(handle, [thing]);
  await until(() => app.knowledgeCurator.status().jobs[0]?.status === 'failed');
  assert.equal(await f.reads(), 0);
});
