import assert from 'node:assert/strict';
import test from 'node:test';
import type {InboxFallbackInput} from '../packages/protocol/src/inbox-conversations.ts';
import {groupFeishuInbox} from '../plugins/feishu-inbox-grouping.ts';

type Msg=InboxFallbackInput['messages'][number];
const now='2026-01-10T12:00:00.000Z';
const msg=(id:string,fields:Partial<Msg>={}):Msg=>({id,title:'相同标题，与 id 或线程无关',at:now,tier:'fyi',...fields});
function plan(messages:Msg[],existing:InboxFallbackInput['existing']=[],kind:InboxFallbackInput['kind']='group') {
  return Object.fromEntries(groupFeishuInbox({messages,existing,kind,now}).assign.map(row=>[row.message,row.event]));
}
test('私聊只把待新建的事项接到最近两小时内最活跃的已给候选，明确回复优先',()=>{
  const existing=[{id:'old',at:'2026-01-10T08:00:00Z'},{id:'recent',at:'2026-01-10T10:00:00Z'}];
  assert.deepEqual(plan([msg('a'),msg('b',{replyToMatterId:'old'})],existing,'direct'),{a:'recent',b:'old'});
  assert.equal(plan([msg('a')],[{id:'expired',at:'2026-01-10T09:59:59.999Z'}],'direct').a,'new:1');
  const near=[{id:'c',at:now},{id:'a',at:now},{id:'d',at:'2026-01-10T11:59:59Z'}];
  assert.equal(plan([msg('z')],near,'direct').z,'c');
  assert.equal(plan([msg('z')],near).z,'new:1');
});

test('群消息按直接父链关联，乱序和重复标题不会改变归属；明确回复胜过话题候选',()=>{
  const candidates=[{id:'red',at:now,topicIds:['topic']},{id:'blue',at:now}];
  const rows=[msg('c',{replyToMessageId:'b'}),msg('b',{replyToMessageId:'a',topicId:'topic'}),
    msg('a',{replyToMatterId:'blue'}),msg('d',{topicId:'unknown-topic'}),
    msg('e',{topicId:'unknown-topic'}),msg('f'),msg('g',{replyToMatterId:'not-a-candidate'})];
  const a=plan(rows,candidates);
  assert.deepEqual(plan([...rows].reverse(),[...candidates].reverse()),a);
  assert.equal(a.a,'blue');assert.equal(a.b,'blue');assert.equal(a.c,'blue');
  assert.match(a.d!,/^new:\d+$/);assert.equal(a.d,a.e);
  assert.notEqual(a.f,a.g);assert.notEqual(a.f,a.d);
});

test('同批命名话题可向未带话题字段的父消息传递证据；相互矛盾的已有事项不能由标题决定',()=>{
  const existing=[{id:'one',at:now,topicIds:['x','both']},{id:'two',at:now,topicIds:['both']}];
  const result=plan([msg('parent'),msg('child',{replyToMessageId:'parent',topicId:'x'}),msg('next',{topicId:'both'}),
    msg('explicit',{topicId:'both',replyToMatterId:'two'}),msg('other',{topicId:'both'})],existing);
  assert.equal(result.parent,'one');assert.equal(result.child,'one');assert.equal(result.explicit,'two');
  assert.match(result.next!,/^new:/);assert.equal(result.next,result.other);
  const cycle=plan([msg('a',{replyToMessageId:'b'}),msg('b',{replyToMessageId:'a'})]);
  assert.notEqual(cycle.a,cycle.b);
});
