import { h } from '../lib/dom.js';
import { Field, Select, TextArea } from '../ui/kit.js';

const tiers = {auto:'自动',wait:'等待模型分拣',action:'需要处理',fyi:'知会'};

export function subscriptionTriageSummary(row) {
  return h('div',{class:'stack small'},
    h('div',null,'回退级别 · '+tiers[row.fallbackTier ?? 'auto']),
    h('div',{style:{whiteSpace:'pre-wrap',overflowWrap:'anywhere'}},'分拣规则 · '+(row.triageRules || '未填写')));
}

export function subscriptionTriage(row) {
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
    rules.value=value.triageRules ?? '';fallback.value=value.fallbackTier ?? 'auto';
    section.open=Boolean(rules.value || fallback.value!=='auto');
    validate();
  }
  set(row);
  return {element:section,set,input:()=>({triageRules:rules.value.trim(),fallbackTier:fallback.value})};
}
