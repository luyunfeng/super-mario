import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { startServer } from '../apps/server/src/index.ts';
import type { Message, QuestionItem } from '../packages/protocol/src/index.ts';
import type { Card } from '../packages/core/src/interactions.ts';

const questions:QuestionItem[] = [
  {question:'部署到哪个环境？',header:'环境',options:[{label:'预发',description:'先验证'},{label:'生产'}]},
  {question:'做哪些检查？',multiSelect:true,options:[{label:'连接'},{label:'日志'}]},
];
const responses = [{selected:[],text:'独立环境'}, {selected:['日志','连接'],text:'再记录结果'}];
const canonical = [{selected:[],text:'独立环境'}, {selected:['连接','日志'],text:'再记录结果'}];

test('真实 HTTP 问题卡核对原题、完整回答和策略建议，重启后保留选择',async t=>{
  const dataDir=await mkdtemp(join(tmpdir(),'mario-structured-'));
  const config={host:'127.0.0.1',port:0,token:'fixture',dataDir,demo:true};
  let server=await startServer(config);
  t.after(async()=>{await server.close();await rm(dataDir,{recursive:true,force:true});});
  const api=(path:string,body?:unknown)=>fetch(server.url+'/api/v1'+path,{method:body?'POST':'GET',
    headers:{authorization:'Bearer fixture','content-type':'application/json'},...(body !== undefined && {body:JSON.stringify(body)})});
  const input={kind:'question',title:'部署前确认',body:'按顺序核对',questions};
  const create=(overrides:object)=>api('/interactions',{...input,...overrides});
  for (const overrides of [{questions:[]},{questions:Array(5).fill(questions[0])},
    {questions:[questions[0],questions[0]]},{questions:[{...questions[0],options:[{label:' 甲 '},{label:'甲'}]}]},
    {questions:[{...questions[0],header:'字'.repeat(13)}]},{questions:[{...questions[0],options:[{label:' x ' }]}]},
    {kind:'permission'},{questions:[{...questions[1],multiSelect:'true'}]}]) assert.equal((await create(overrides)).status,400);
  assert.equal(server.app.interactions.list().length,0);
  server.app.policies.write({}, {ladder:['rules','user'],rules:[{id:'fixture',kind:'question',handler:'rules',mode:'auto',answer:'建议先预发'}]});
  const first=(await (await create({})).json()) as Card;
  const get=()=>server.app.store.get<Card>('interactions',first.id)!;
  await t.waitFor(()=>assert.equal(get().handler,'user'));
  const pending=get();
  assert.equal(pending.status,'open'); assert.equal(pending.suggestion,'建议先预发'); assert.equal(pending.answers,undefined);
  const attention=(await (await api('/attention')).json()).find((r:{id:string})=>r.id==='interaction:'+first.id);
  assert.deepEqual(attention.questions,questions);assert.equal(attention.actions[0].body.version,pending.version);
  const submit=(fields:object)=>api('/interactions/'+first.id+'/answer',{version:pending.version,...fields});
  for(const fields of [{text:'绕过选项'}, {answers:'绕过'}, {answers:responses,text:'双份'},
    {answers:[]},{answers:[{selected:['预发']}]},{answers:[{selected:[]},responses[1]]},
    {answers:[{selected:['预发','生产']},responses[1]]}, {answers:[{selected:['预发']},{selected:['连接','连接']}]},
    {answers:[{selected:['生成的选项']},responses[1]]},{answers:[{selected:['预发'],extra:true},responses[1]]}]) {
    assert.equal((await submit(fields)).status,400);
    assert.equal(get().version,pending.version);
  }
  const accepted=await submit({answers:responses});
  assert.equal(accepted.status,200);
  assert.deepEqual(get().answers,canonical);
  assert.match(get().answer!,/做哪些检查？\n选择：连接、日志\n自填回答：再记录结果/);
  assert.equal((await submit({answers:responses})).status,409);
  await server.close();server=await startServer(config);
  assert.deepEqual(get().answers,canonical);
  server.app.policies.write({},{ladder:['user'],rules:[]});
  const plain=(await (await create({questions:undefined})).json()) as Card;
  assert.equal((await api('/interactions/'+plain.id+'/answer',{version:plain.version,answers:responses})).status,400);
  assert.equal((await api('/interactions/'+plain.id+'/answer',{version:plain.version,text:'普通文本'})).status,200);

  const owner=await (await api('/messages',{text:'合成请求'})).json() as Message;
  const quotedQuestions=[{question:'要跑哪些检查？',options:[{label:'连接、稳定'},{label:'单项检查'}]}];
  const choice=[{selected:['连接、稳定'],text:'第一行\n选择：只是说明'}];
  const linked=server.app.interactions.open({...input,kind:'question',questions:quotedQuestions},owner);
  assert.equal((await api('/interactions/'+linked.id+'/answer',{version:linked.version,answers:choice})).status,200);
  const resumedId=server.app.store.get<{continuationId:string}>('interaction-origins',linked.id)!.continuationId;
  const message=server.app.store.get<Message>('messages',resumedId)!;
  assert.deepEqual(JSON.parse(message.text.slice(message.text.indexOf('\n')+1)).逐题回答,[{问题:'要跑哪些检查？',已选:['连接、稳定'],补充:'第一行\n选择：只是说明'}]);
  const deferred=server.app.interactions.open({...input,kind:'question'},owner);
  server.app.interactions.expireTick(Date.parse(deferred.expiresAt)+1);
  const todo=server.app.todos().find(row=>row.deferredQuestion?.cardId===deferred.id)!;
  const path='/todos/'+todo.id+'/question-answer';
  assert.deepEqual(todo.deferredQuestion?.questions,questions);
  assert.equal((await api('/todos/'+todo.id+'/decisions',{text:'这是一条备注决定'})).status,201);
  assert.ok(!server.app.todos().find(row=>row.id===todo.id)?.completedAt);
  assert.equal((await api(path,{text:'不逐题回答'})).status,400);
  assert.equal((await api(path,{answers:[responses[0]]})).status,400);
  const answer=await api(path,{answers:responses});assert.equal(answer.status,200);
  const receipt=await answer.json();
  const late=server.app.store.get<Message>('messages',receipt.messageId)!.text;
  assert.deepEqual(JSON.parse(late.slice(late.indexOf('\n')+1)).逐题回答,[
    {问题:questions[0]!.question,已选:[],补充:'独立环境'},{问题:questions[1]!.question,已选:['连接','日志'],补充:'再记录结果'},
  ]);
  const stored=server.app.store.get<Card>('interactions',deferred.id)!;
  assert.equal(stored.status,'expired');assert.deepEqual(stored.answers,canonical);
  assert.deepEqual(await (await api(path,{answers:canonical})).json(),receipt);
  assert.equal((await api(path,{answers:[{selected:['预发']},responses[1]]})).status,409);
});
