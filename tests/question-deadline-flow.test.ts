import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { startServer } from '../apps/server/src/index.ts';
import type { Card } from '../packages/core/src/interactions.ts';
import type { Message } from '../packages/protocol/src/index.ts';

const options = [{label:'按月份',description:'方便按月核对。'},{label:'按部门'}];
async function fixture(t:TestContext) {
  const dataDir = await mkdtemp(join(tmpdir(),'mario-system-question-result-'));
  const config = {dataDir,host:'127.0.0.1',port:0,demo:true};
  let server = await startServer(config);
  t.after(async () => { await server.close(); await rm(dataDir,{recursive:true,force:true}); });
  function api(path:string, data:unknown) {
    return fetch(server.url + '/api/v1' + path,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(data)});
  }
  const speak = async (text:string, projectId?:string) => {
    const res = await api('/messages',{text,projectId}); assert.equal(res.status,202);
    return await res.json() as Message;
  };
  const ask = (source: Message, wait: boolean) => server.app.interactions.open({
    kind:'question',title:'请选一种排列方法',body:'只讨论列的展示顺序。',wait,deadline:'2m',reversible:true,
    questions:[{question:'表格如何排列？',options,recommend:'按月份'}],
  },source);
  const card = (id:string) => server.app.store.get<Card>('interactions',id)!;
  const output = (id:string) => server.app.store.list<Message>('messages').filter(message =>
    message.role === 'user' && message.text.includes('"卡片":"'+id+'"'));
  const tick = (question:Card) => server.app.interactions.expireTick(Date.parse(question.decisionDeadlineAt!) + 1);
  return {get app(){return server.app;},api,speak,ask,card,output,tick,
    async restart(){await server.close();server=await startServer(config);}};
}

test('等待及稍后提问到期采用推荐，仅给原 Web 作用域投递一次只读系统结果', async t => {
  const f = await fixture(t);
  const project = f.app.projects.create({name:'合成截止项目'});
  for (const wait of [true,false]) {
    const input = await f.speak('请决定表格排序。',project.id);
    const card = f.ask(input,wait);
    f.tick(card); f.tick(card);
    await t.waitFor(() => assert.equal(f.card(card.id).delivery,'confirmed'));
    const [result] = f.output(card.id);
    assert.equal(f.output(card.id).length,1);
    assert.equal(f.card(card.id).byDefault,true);
    assert.equal(f.card(card.id).answeredBy,'deadline_default');
    assert.equal(result.projectId,project.id); assert.equal(result.conversationId,'main');
    assert.equal(result.origin,'notification'); assert.equal(result.readOnly,true); assert.ok(!result.directWebInput);
    assert.match(result.text,/系统默认选择/); assert.ok(result.text.includes('按月份')); assert.doesNotMatch(result.text,/主人回答/);
    assert.equal(f.app.store.get('conversation.question-continuations',result.id),undefined);
    assert.throws(()=>f.ask(result,true),{status:403});
    await f.restart();
    await t.waitFor(()=>assert.equal(f.card(card.id).delivery,'confirmed'));
    assert.equal(f.output(card.id).length,1);
  }
  assert.equal(f.app.store.list('runs').length,0);
  assert.equal(f.app.store.list('approvals').length,0);
  assert.deepEqual(f.app.todos(),[]);
});

test('普通截止结果在中断后重投一次，稍后卡已听到主人发言则过期且不建待办',async t=>{
  const f = await fixture(t);
  const card = f.ask(await f.speak('按建议选。'),true);
  const post = f.app.agent.post;
  f.app.agent.post = async()=>{throw new Error('合成回投进程停止');};
  try {
    f.tick(card);
    await t.waitFor(()=>assert.equal(f.card(card.id).delivery,'failed'));
    assert.deepEqual(f.output(card.id),[]);
  } finally { f.app.agent.post=post; }
  await f.restart();
  await t.waitFor(()=>assert.equal(f.card(card.id).delivery,'confirmed'));
  assert.equal(f.output(card.id).length,1);
  const skipped = f.ask(await f.speak('先留一个稍后问题。'),false);
  await f.speak('这期间只讨论新的排期。');
  f.tick(skipped);
  await t.waitFor(()=>assert.equal(f.output(skipped.id).length,1));
  assert.equal(f.card(skipped.id).status,'expired');
  assert.equal(f.card(skipped.id).byDefault,undefined);
  assert.match(f.output(skipped.id)[0].text,/没有创建待办/);
  assert.deepEqual(f.app.todos(),[]);
  await f.restart();
  assert.equal(f.output(card.id).length,1);
  assert.equal(f.output(skipped.id).length,1);
});

test('项目归档后，截止卡不能从当前主对话接收其他受众的默认选择',async t=>{
  const f=await fixture(t);
  const project=f.app.projects.create({name:'期限内归档的项目'});
  const card=f.ask(await f.speak('这个问题留在原项目处理',project.id),false);
  f.app.projects.archive(project.id);
  f.tick(card);
  await f.restart();
  f.tick(card);
  assert.equal(f.card(card.id).byDefault,undefined);
  assert.equal(f.card(card.id).status,'open');
  assert.deepEqual(f.output(card.id),[]);
});
