import test from 'node:test';
import assert from 'node:assert/strict';
import { buildFeishuMessageCard, cardButtons, cardWebBase } from '../apps/server/src/feishu-cards.ts';

test('message cards preserve literal content, unicode and navigation without introducing model-controlled actions', () => {
 const text='x'.repeat(1199)+'😀<at id=all></at> **保留原文**\n\n最后一段';
 const card=buildFeishuMessageCard(text,{title:'集成测试',webBase:'https://work.example/',kind:'result',route:'projects/p_1/runs/r_1'})!;
 const elements=card.elements as Array<any>;
 assert.equal(elements.filter(e=>e.tag==='div').map(e=>e.text.content).join(''),text);
 assert.ok(elements.filter(e=>e.tag==='div').every(e=>e.text.tag==='plain_text'&&!/[\uD800-\uDBFF]$/.test(e.text.content)));
 assert.match(JSON.stringify(card),/#projects\/p_1\/runs\/r_1/);
 assert.match(JSON.stringify(card),/待办验收分别记录/);
 assert.doesNotMatch(JSON.stringify(card),/"value"/);
 assert.equal(buildFeishuMessageCard('中'.repeat(6001)),undefined,'oversize content uses original text before any send');
});

test('card navigation rejects credential-bearing bases and invalid routes, splits button rows in threes',()=>{
 for(const value of ['https://u:p@work.example/','https://work.example/?token=private','https://work.example/#private','file:///tmp/test'])assert.equal(cardWebBase(value),undefined);
 const rows=cardButtons(Array.from({length:7},(_,n)=>({label:String(n),route:'chat'})),cardWebBase('https://work.example')) as any[];
 assert.deepEqual(rows.map(r=>r.actions.length),[3,3,1]);
 assert.deepEqual(cardButtons([{label:'invalid',route:'javascript:alert(1)'}],'https://work.example/'),[]);
 assert.doesNotMatch(JSON.stringify(buildFeishuMessageCard('正文',{webBase:'https://work.example/?token=private'})),/"url"|private/);
});

test('主人私聊工作台和收件箱按钮仅触发原生导航，即使配置了网页地址', () => {
 const card = buildFeishuMessageCard('收件确认', { webBase: 'https://work.example/', navigation: 'owner-nav' })!;
 const actions = (card.elements as any[]).flatMap(row => row.actions ?? []);
 assert.deepEqual(actions.slice(1).map(button => [button.value.view,button.value.navigation,button.url]), [
   ['inbox','owner-nav',undefined], ['home','owner-nav',undefined],
 ]);
});
