import { h, readLocal, writeLocal } from '../lib/dom.js';

const schemas = {
  'token-statistics': [
    { key: 'defaultDays', label: '默认统计范围', choices: [[1,'今天'],[7,'最近 7 天'],[30,'最近 30 天'],[0,'全部日期']], initial: 7 },
    { key: 'sessionLimit', label: '每次最多读取的会话数', min: 1, max: 64, initial: 16 },
  ],
};
function valid(field, value) {
  return Number.isInteger(value) && (field.choices ? field.choices.some(([n]) => n === value) : value >= field.min && value <= field.max);
}
export function preferences(id) {
  const saved = readLocal('sm.plugin.preferences.' + id, {});
  return Object.fromEntries((schemas[id] ?? []).map(f => [f.key, valid(f,saved?.[f.key]) ? saved[f.key] : f.initial]));
}
export function preferenceEditor(id) {
  const fields = schemas[id];
  if (!fields) return null;
  let json = false;
  const saved = preferences(id), controls = new Map();
  const editor = h('textarea', { rows: 6, 'aria-label': 'JSON 配置', spellcheck:false });
  const notice = h('p', { role:'status' });
  const form = h('div',{class:'stack'},fields.map(f => {
    const input = f.choices ? h('select',{},f.choices.map(([n,label])=>h('option',{value:n},label))) : h('input',{type:'number', min:f.min,max:f.max});
    input.value = saved[f.key];
    controls.set(f.key,input);
    return h('label',{class:'pref-field'},f.label,input);
  }));
  function draft() {
    const data = json ? JSON.parse(editor.value) : Object.fromEntries([...controls].map(([k,input])=>[k,input.value === '' ? null : Number(input.value)]));
    if (!data || Array.isArray(data) || typeof data !== 'object' || Object.keys(data).some(k=>!controls.has(k))) throw Error('配置必须是只含已声明字段的 JSON 对象');
    for (const f of fields) if (!valid(f,data[f.key])) throw Error(f.label+'：请选择有效值'+(f.min ? '（'+f.min+'–'+f.max+'）':''));
    return data;
  }
  editor.hidden = true;
  const mode = h('button',{class:'btn btn--sm',onclick:()=>{
    try {
      const data=draft();
      editor.value=JSON.stringify(data,null,2);
      for(const [k,input] of controls) input.value=data[k];
      json=!json; editor.hidden=!json; form.hidden=json; mode.textContent=json?'切换到表单':'编辑 JSON'; notice.textContent='';
    } catch(e) { notice.textContent=e.message; }
  }},'编辑 JSON');
  return h('div',{class:'pref-editor stack'},h('h3',{},'使用偏好'),h('p',{class:'small muted'},'保存在当前浏览器，下次打开插件时生效。'),mode,form,editor,
    h('button',{class:'btn btn--primary',onclick:()=>{try{writeLocal('sm.plugin.preferences.'+id,draft()); notice.textContent='设置已保存';}catch(e){notice.textContent=e.message;}}},'保存设置'),notice);
}
