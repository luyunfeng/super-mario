import assert from 'node:assert/strict';
import test from 'node:test';
import {subscriptionInboxGroups,type HeldInboxItem} from '../packages/core/src/subscription-inbox-groups.ts';

const at=(minute:number)=>new Date(Date.UTC(2026,0,1,0,minute)).toISOString();
function held(n:number,fields:Partial<HeldInboxItem['item']>={},stored=n):HeldInboxItem {
  return {item:{id:'id'+n,title:'标题 '+n,text:'正文 '+n,...fields},storedAt:at(stored),sequence:n};
}
test('首次普通条目超过三项才合并，仍到期的独立分组，摘要最多列五十项',()=>{
  const rows=Array.from({length:53},(_,i)=>held(i));
  rows.push(held(53,{dueAt:at(61)}),held(54,{dueAt:at(60)}),held(61));
  const input={name:'版本更新',held:rows,pendingIds:rows.map(row=>row.item.id),catchupAt:at(60)};
  const [digest,due,live]=subscriptionInboxGroups(input);
  assert.equal(digest!.thread,'digest:'+at(60));
  assert.equal(digest!.itemIds.length,54);
  assert.equal(digest!.due,false);
  assert.equal(digest!.receivedAt,at(54));
  assert.equal(digest!.text.split('\n').length,51);
  assert.ok(digest!.text.startsWith(at(54)+' · 标题 54'));
  assert.match(digest!.text,/另有 4 条$/);
  assert.deepEqual([due!.thread,due!.last,due!.due],['item:id53','id53',true]);
  assert.equal(live!.thread,'item:id61');
  assert.deepEqual(subscriptionInboxGroups({...input,held:rows.slice(0,3)}).map(x=>x.thread),['item:id0','item:id1','item:id2']);
  const replay=subscriptionInboxGroups({...input,pendingIds:['id0'],held:[...rows].reverse()});
  assert.deepEqual(replay,[{...digest,itemIds:['id0']}]);
});

test('来源话题跨页保留最近十条上下文，补到较旧正文时卡片版本也变',()=>{
  const rows=Array.from({length:13},(_,i)=>held(i,{thread:'话题 A',occurredAt:at(i===12?99:i)},i===12?12:20));
  rows[11]!.item.dueAt=at(100);
  rows[12]!.item.text='字'.repeat(3001);
  const input={name:'源名称',held:rows,pendingIds:['id12']};
  const group=subscriptionInboxGroups(input)[0]!;
  assert.deepEqual([group.thread,group.title,group.due,group.itemIds],['thread:话题 A','标题 12',true,['id12']]);
  assert.ok(group.text.startsWith(at(2)+' · 标题 2\n'));
  assert.ok(group.text.includes('\n标题 12\n'+at(12)));
  assert.ok(group.text.endsWith('字'.repeat(3000)));
  assert.equal(group.text.match(/字/g)?.length,3000);
  assert.equal(group.receivedAt,at(12));
  const previous=subscriptionInboxGroups({...input,held:[rows[12]!]})[0]!;
  assert.notEqual(previous.last,group.last);
  const partial=subscriptionInboxGroups({...input,held:[...rows].reverse(),pendingIds:['id11']})[0]!;
  assert.deepEqual(partial,{...group,itemIds:['id11']});
});

test('整订阅合并使用订阅名，调整分组只纳入边界之后的内容',()=>{
  const heldItems=[held(1,{thread:'old'}),held(2,{thread:'other'}),held(3)];
  const groups=subscriptionInboxGroups({name:'仓库发布',inboxGroup:'source',held:heldItems,pendingIds:['id1','id3'],groupFrom:at(2)});
  assert.equal(groups.length,1);
  const group=groups[0]!;
  assert.deepEqual([group.thread,group.title,group.itemIds],['source','仓库发布',['id3']]);
  assert.ok(group.text.includes('标题 2'));
  assert.ok(!group.text.includes('标题 1'));
  assert.deepEqual(subscriptionInboxGroups({name:'仓库发布',held:heldItems,pendingIds:[]}),[]);
});

test('工作台时区用于摘要和话题上下文，夏令时回拨后保留明确偏移和原始截止时刻',()=>{
  const timezone='America/New_York';
  const early='2026-11-01T05:30:00Z',late='2026-11-01T06:30:00Z',dueAt='2026-11-02T20:30:00+08:00';
  const heldItems=Array.from({length:4},(_,n)=>({
    ...held(n,{thread:'group',occurredAt:n===3?late:early}),storedAt:late,
  }));
  const input={timezone,name:'发布',held:heldItems,pendingIds:['id3']};
  const [summary]=subscriptionInboxGroups({...input,catchupAt:late});
  const summer=/2026-11-01 01:30:00 GMT[-−]04:00/;
  const winter=/2026-11-01 01:30:00 GMT[-−]05:00/;
  assert.match(summary!.text,summer);
  assert.match(summary!.text,winter);
  heldItems[3]!.item.dueAt=dueAt;
  const [group]=subscriptionInboxGroups(input);
  assert.match(group!.text,summer);
  assert.match(group!.text,winter);
  assert.equal(group!.receivedAt,new Date(late).toISOString());
  assert.ok(group!.text.includes('截止时间：'+dueAt));
});
