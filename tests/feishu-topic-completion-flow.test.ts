import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { startServer } from '../apps/server/src/index.ts';
import type { FeishuOptions, FeishuMessageSource, FeishuSendContext } from '../plugins/feishu.ts';
import type { Todo } from '../packages/protocol/src/index.ts';

test('Web 完成直接开题的待办只向原话题发一次短通知，撤销登记和迁入项目后不发', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'sm-direct-topic-completion-'));
  const config = {host:'127.0.0.1',port:0,dataDir:dir,demo:true,token:'synthetic'};
  let botEvents!: FeishuOptions;
  const sent: Array<{chat:string;text:string;context?:FeishuSendContext}> = [];
  const factory = (options:FeishuOptions) => {
    botEvents = options;
    return {async start() {}, async close() {}, async collect() {return [];}, status:() => ({connected:true}),
      async send(chat:string, text:string, context?:FeishuSendContext) {
        context?.groupReadReply?.(); context?.beforeSend?.();
        sent.push({chat,text,context}); context?.onSent?.('om_ack_' + sent.length,'text');
      }};
  };
  const wait = (check: () => void) => t.waitFor(check, {timeout: 8000});
  let host = await startServer(config,{botFactory:factory});
  t.after(async () => {try {await host.close();} finally {await rm(dir,{recursive:true,force:true});}});
  async function api<T>(path:string, method = 'GET', body?:object) {
    const res = await fetch(host.url + '/api/v1/' + path,{method,headers:{authorization:'Bearer synthetic','content-type':'application/json'},
      ...(body && {body:JSON.stringify(body)})});
    if (!res.ok) throw Error(path + ' HTTP ' + res.status + ' ' + await res.text());
    return res.json() as Promise<T>;
  }
  const bot = await host.bots.create({name:'合成话题机器人',appId:'cli_5555555555555555',appSecret:'fixture',
    scope:{kind:'global'},requireConfirmation:false});
  const emit = (chatId:string,messageId:string,text:string,extra:Partial<FeishuMessageSource>={}) =>
    botEvents.onMessage(text,{senderType:'user',senderId:'ou_owner',chatType:'group',chatId,messageId,...extra});
  await emit('oc_private','om_pair',bot.pairingCode!,{chatType:'p2p'});
  await emit('oc_main','om_enroll_main','/topics');
  await emit('oc_separate','om_enroll_separate','/topics');
  async function open(chatId:string, key:string) {
    const title = '合成话题任务-' + key;
    await emit(chatId,'om_root_' + key,title,{threadId:'omt_' + key});
    await wait(() => assert.ok(sent.some(s => s.chat === chatId && s.context?.replyTo === 'om_root_' + key && s.text.includes(title))));
    const todo = (await api<Todo[]>('todos')).find(row => row.title === title);
    assert.ok(todo); return todo;
  }
  const main = await open('oc_main','main');
  const moved = await open('oc_main','moved');
  const revoked = await open('oc_separate','revoked');
  const control = await open('oc_main','control');
  // A later owner message becomes the parent, while the opening still fixes the thread and task.
  await emit('oc_main','om_later','合成后续决定',{threadId:'omt_main',rootId:'om_root_main',parentId:'om_root_main'});
  await wait(() => assert.ok(sent.some(s => s.context?.replyTo === 'om_later' && s.text.includes('合成后续决定'))));
  const project = host.app.projects.create({name:'项目私有合成标记'});
  await api('todos/' + main.id,'PATCH',{notes:'合成私有备注，不应出现在完成通知'});
  await api('todos/' + moved.id,'PATCH',{projectId:project.id});
  await emit('oc_separate','om_revoke','/topics off');
  const start = sent.length;
  const finish = (todo:Todo) => api<Todo>('todos/' + todo.id,'PATCH',{completed:true});
  const finished = await finish(main);
  assert.ok(finished.completedAt);
  await wait(() => assert.ok(sent.slice(start).some(s => s.context?.replyTo === 'om_later' && s.text.includes('完成'))));
  await finish(main);
  await finish(moved);
  await finish(revoked);
  await finish(control);
  await wait(() => assert.ok(sent.slice(start).some(s => s.context?.replyTo === 'om_root_control' && s.text.includes('完成'))));
  const receipts = () => sent.slice(start).filter(row => row.text.includes('完成'));
  const expected = [['oc_main','om_later','omt_main'],['oc_main','om_root_control','omt_control']];
  assert.deepEqual(sent.slice(start).map(row => [row.chat,row.context?.replyTo,row.context?.threadId]),expected);
  for (const row of receipts()) {
    assert.ok(Array.from(row.text).length < 100);
    assert.doesNotMatch(row.text,/合成私有备注|项目私有合成标记|合成后续决定/);
  }
  const prior = botEvents;
  await host.close(); host = await startServer(config,{botFactory:factory});
  await wait(() => assert.notEqual(botEvents,prior));
  const more = await open('oc_main','restart');
  await finish(more);
  await wait(() => assert.ok(receipts().some(s => s.context?.replyTo === 'om_root_restart')));
  assert.deepEqual(receipts().map(row => row.context?.replyTo),['om_later','om_root_control','om_root_restart']);
});
