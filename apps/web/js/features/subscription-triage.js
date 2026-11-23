import { h } from '../lib/dom.js';
import { Field, Select, TextArea } from '../ui/kit.js';

const tiers = {auto:'自动',wait:'等待模型分拣',action:'需要处理',fyi:'知会'};

const grouping={thread:'按来源话题分卡',source:'整条订阅使用一张卡'};

export function subscriptionTriageSummary(row) {
  return h('div',{class:'stack small'},
    row.mode!=='snapshot' && h('div',null,'收件分组 · '+grouping[row.inboxGroup ?? 'thread']),
    h('div',null,'回退级别 · '+tiers[row.fallbackTier ?? 'auto']),
    h('div',{style:{whiteSpace:'pre-wrap',overflowWrap:'anywhere'}},'分拣规则 · '+(row.triageRules || '未填写')));
}

export function subscriptionTriage(row) {
  const group=Select({options:Object.entries(grouping)});
  const groupField=Field({label:'收件分组',control:group,hint:'按话题分卡时，没有来源话题的条目各占一张卡。修改只影响后续新内容。'});
  function setMode(mode) {
    groupField.hidden=mode==='snapshot';group.disabled=groupField.hidden;
    if(group.disabled) group.value='thread';
  }
  const rules=TextArea({rows:3});
  const fallback=Select({options:Object.entries(tiers)});
  const section=h('details',null,h('summary',null,'收件箱分拣'),
    h('div',{class:'stack'},Field({label:'分拣规则',control:rules,hint:'仅用于本订阅的收件箱内容，最多 4000 字。留空时使用来源提供的规则（如有）。'}),
      Field({label:'回退级别',control:fallback,hint:'模型未给出分拣结果时使用。'})));
  function validate() {
    rules.setCustomValidity(Array.from(rules.value.trim()).length>4000 ? '分拣规则最多 4000 字。' : '');
  }
  rules.addEventListener('input',validate);
  rules.addEventListener('invalid',()=>{section.open=true;});
  function set(value={}) {
    setMode(value.mode);group.value=value.inboxGroup ?? 'thread';
    rules.value=value.triageRules ?? '';fallback.value=value.fallbackTier ?? 'auto';
    section.open=Boolean(rules.value || fallback.value!=='auto');
    validate();
  }
  set(row);
  return {element:h('div',{class:'stack'},groupField,section),set,setMode,input:()=>({
    triageRules:rules.value.trim(),fallbackTier:fallback.value,...(!group.disabled && {inboxGroup:group.value})
  })};
}
