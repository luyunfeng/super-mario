import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { startServer } from '../apps/server/src/index.ts';
import type { FeishuOptions, FeishuSendContext } from '../plugins/feishu.ts';
import type { Todo } from '../packages/protocol/src/index.ts';

test('Web 主人决定聚合回最新有效话题消息，话题决定和撤权记录不外发，完成链接只取显式 Web 地址', { timeout: 40000 }, async t => {
  const dir = await mkdtemp(join(tmpdir(), 'topic-decision-post-'));
  const previous = process.env.SUPER_MARIO_WEB_URL;
  delete process.env.SUPER_MARIO_WEB_URL;
  const token = 'synthetic-topic-owner';
  let botEvents!: FeishuOptions;
  const sent: Array<{ chat:string; text:string; context?:FeishuSendContext }> = [];
  const open = (port:number) => startServer({host:'127.0.0.1',port,dataDir:dir,token,demo:true},{
    botFactory(options) {
      botEvents = options;
      return { async start() {}, async close() {}, async collect() {return [];}, status:() => ({connected:true}),
        async send(chat,text,context) {
          context?.beforeSend?.(); context?.groupReadReply?.();
          sent.push({chat,text,context}); context?.onSent?.('ack-' + sent.length,'text');
        }};
    },
  });
  let server = await open(0);
  t.after(async () => {
    try { await server.close(); } finally {
      if (previous === undefined) delete process.env.SUPER_MARIO_WEB_URL;
      else process.env.SUPER_MARIO_WEB_URL = previous;
      await rm(dir,{recursive:true,force:true});
    }
  });
  async function api<T>(path:string,method='GET',body?:object) {
    const response = await fetch(server.url + '/api/v1/' + path,{method,
      headers:{authorization:'Bearer ' + token,'content-type':'application/json'},...(body && {body:JSON.stringify(body)})});
    if (!response.ok) throw Error(path + ' HTTP ' + response.status + ' ' + await response.text());
    return response.json() as Promise<T>;
  }
  const wait = (check:()=>void) => t.waitFor(check,{timeout:9000});
  const bot = await server.bots.create({name:'合成群助理',appId:'cli_5555555555555555',appSecret:'fixture',scope:{kind:'global'}});
  const emit = (chatId:string,messageId:string,text:string,threadId?:string,rootId?:string,senderId='ou_owner') => botEvents.onMessage(text,{
    senderType:'user',senderId,chatType:'group',chatId,messageId,threadId,rootId,parentId:rootId});
  await botEvents.onMessage(bot.pairingCode!,{senderType:'user',senderId:'ou_owner',chatType:'p2p',chatId:'oc_private',messageId:'om_pair'});
  async function task(key:string) {
    const chat = 'oc_' + key, root = 'om_root_' + key, thread = 'omt_' + key, title = '合成话题任务-' + key;
    await emit(chat,'om_enroll_' + key,'/topics');
    await emit(chat,root,title,thread);
    await wait(() => assert.ok(sent.some(s => s.context?.replyTo === root && s.text.includes(title))));
    const todo = (await api<Todo[]>('todos')).find(t => t.title === title);
    assert.ok(todo); return {chat,root,thread,todo};
  }
  const add = (todo:Todo,text:string) => api('todos/' + todo.id + '/decisions','POST',{text,expectedProjectId:null});
  const finish = (todo:Todo) => api('todos/' + todo.id,'PATCH',{completed:true});
  const first = await task('unconfigured');
  await finish(first.todo);
  await wait(() => assert.ok(sent.some(s => s.context?.replyTo === first.root && s.text.includes('已完成'))));
  const plain = sent.find(s => s.context?.replyTo === first.root && s.text.includes('已完成'))!;
  assert.doesNotMatch(plain.text,/https?:\/\/|#projects\/|token=/i);

  const main = await task('main'), revoked = await task('revoked');
  const port = Number(new URL(server.url).port);
  const web = 'http://topic-proof.test:' + port;
  await server.close();
  process.env.SUPER_MARIO_WEB_URL = web + '/ignored-base-path';
  server = await open(port);
  await wait(() => assert.ok(botEvents.topicPolicy?.(main.chat)));
  const origin = '合成话题内的原发决定';
  await emit(main.chat,'om_original_decision',origin,main.thread,main.root);
  await wait(() => assert.ok(sent.some(s => s.context?.replyTo === 'om_original_decision' && s.text.includes(origin))));
  // A restart, an unrelated participant and a redelivery of the old opening cannot replace the latest owner message.
  await server.close();
  server = await open(port);
  await wait(() => assert.ok(botEvents.topicPolicy?.(main.chat)));
  await emit(main.chat,main.root,main.todo.title,main.thread);
  await emit(main.chat,'om_foreign','群友补充',main.thread,main.root,'ou_foreign');
  const at = sent.length;
  const secret = ['私有决定甲-测试标记','私有决定乙-测试标记','撤权待发决定-测试标记','撤权后决定-测试标记'];
  const privatePath = '/api/v1/todos/' + main.todo.id + '/decisions';
  const unauth = await fetch(server.url + privatePath);
  assert.equal(unauth.status,401); assert.ok(!(await unauth.text()).includes(origin));
  await add(revoked.todo,secret[2]);
  await emit(revoked.chat,'om_off','/topics off');
  await add(revoked.todo,secret[3]);
  await Promise.all([add(main.todo,secret[0]),add(main.todo,secret[1])]);
  await wait(() => assert.ok(sent.slice(at).some(s => s.context?.replyTo === 'om_original_decision')));
  const summaries = sent.slice(at).filter(s => s.context?.replyTo !== 'om_off');
  assert.equal(summaries.length,1);
  const summary = summaries[0];
  assert.deepEqual([summary.chat,summary.context?.threadId,summary.context?.replyTo],[main.chat,main.thread,'om_original_decision']);
  assert.match(summary.text,/2/); assert.match(summary.text,/决定|决策/);
  assert.ok(!secret.some(text => summary.text.includes(text)));
  assert.ok(!summary.text.includes(origin));
  const decisions = await api<{decisions:Array<{source:string;text:string}>}>('todos/' + main.todo.id + '/decisions');
  assert.deepEqual(decisions.decisions.map(d=>d.text).sort(),[origin,...secret.slice(0,2)].sort());
  // A second topic supplies an observable flush while the recalled source must stay silent.
  const control = await task('control');
  const beforeRecall = sent.length;
  const clock = Date.now;
  t.mock.method(Date, 'now', () => clock() + 61_000);
  await add(main.todo,'父消息撤回前进入待发批次的私有决定');
  assert.ok(botEvents.onRecall);
  await botEvents.onRecall(main.chat, 'om_original_decision');
  await add(main.todo,'已撤回父消息期间的私有决定');
  await add(control.todo,'对照组私有决定');
  await emit(control.chat,'om_new_while_pending','聚合窗口内新增的主人发言',control.thread,control.root);
  await wait(() => assert.ok(sent.slice(beforeRecall).some(s => s.chat === control.chat && s.context?.replyTo === 'om_new_while_pending' && s.text.includes('待办新增'))));
  assert.ok(!sent.slice(beforeRecall).some(s => s.chat === main.chat && s.text.includes('待办新增')));
  await botEvents.onRecall(main.chat, main.root);
  await emit(main.chat,'om_fresh','主人重新发言',main.thread,main.root);
  await wait(() => assert.ok(sent.some(s => s.context?.replyTo === 'om_fresh' && s.text.includes('主人重新发言'))));
  await finish(main.todo);
  await wait(() => assert.ok(sent.slice(at).some(s => s.context?.replyTo === 'om_fresh' && s.text.includes('已完成'))));
  const notice = sent.slice(at).find(s => s.context?.replyTo === 'om_fresh' && s.text.includes('已完成'))!;
  const href = notice.text.match(/https?:\/\/[^\s]+/u)?.[0];
  assert.equal(href,web + '/#projects/all/todos/detail/' + main.todo.id);
  assert.equal(notice.chat,main.chat); assert.equal(notice.context?.threadId,main.thread);
  assert.ok(![token, 'token=', ...secret].some(text => notice.text.includes(text)));
});
