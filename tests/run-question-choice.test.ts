import assert from 'node:assert/strict';
import test from 'node:test';
import type { Card } from '../packages/core/src/interactions.ts';
import { readRunQuestionChoice } from '../packages/core/src/run-question-choice.ts';

const question={question:'选择顺序',options:[{label:'按月份'},{label:'按部门'}],recommend:'按部门'};
const card:Card={id:'synthetic-card',version:2,kind:'question',title:'核对表格',body:'',runId:'r',handler:'user',layer:'task',
  status:'open',createdAt:'2026-11-01',updatedAt:'2026-11-01',expiresAt:'2099-01-01',questions:[question]};
const select=(text:string,unique=true)=>readRunQuestionChoice(card,text,card.id,2,unique);
const header='回答提问 synthetic-card v2';

test('唯一原卡的单题接受明确原选项，有歧义时只能明确指定卡及版本',()=>{
  assert.deepEqual(select('按月份'),[{selected:['按月份']}]);
  for (const text of ['我不同意按月份','「按月份」','选推荐的','如果选按月份呢？','按月份\n改为按部门'])
    assert.throws(()=>select(text));
  assert.throws(()=>select('按月份',false));
  assert.deepEqual(select(header+'\n1. 按月份',false),[{selected:['按月份']}]);
  assert.throws(()=>select('不能执行\n'+header+'\n1. 按月份'));
  assert.throws(()=>select(header.replace('v2','v1')+'\n1. 按月份'));
  assert.throws(()=>readRunQuestionChoice(card,'按月份',card.id,1,true),{status:409});
  assert.throws(()=>readRunQuestionChoice({...card,kind:'permission'},'按月份',card.id,2,true),{status:403});
});

test('多题每题须有原标签，多选使用重复题号，推荐值不会补全遗漏',()=>{
  const form={...card,questions:[question,{...question,question:'同时包含哪些分组？',multiSelect:true}]};
  const parse=(rows:string)=>readRunQuestionChoice(form,header+'\n'+rows,form.id,2,true);
  assert.deepEqual(parse('1. 按月份\n2. 按部门\n2. 按月份'),[{selected:['按月份']},{selected:['按月份','按部门']}]);
  for (const rows of ['1. 按月份','1. 按月份\n2. 其他','1. 按月份\n1. 按部门\n2. 按月份','1. 按月份\n2. 按月份\n2. 按月份'])
    assert.throws(()=>parse(rows));
});
