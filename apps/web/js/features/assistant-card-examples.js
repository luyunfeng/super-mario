import {h,replace,svg} from '../lib/dom.js';
import {Button,Pill} from '../ui/kit.js';
import {openDrawer} from '../ui/overlay.js';

const examples=[
  ['decision','决策'],['compare','比较'],['progress','进度'],
  ['form','表单'],['chart','图表'],['html','HTML'],
];
const choices=[
  {name:'A 重写同步层',estimate:'3 天',risk:'高',recommendation:'长期考虑'},
  {name:'B 队列去重',estimate:'半天',risk:'低',recommendation:'优先选择'},
  {name:'C 增加监控',estimate:'1 小时',risk:'低'},
];
const field=(label,input)=>h('label',{class:'field'},label,input);
function table(headers,rows){
  return h('table',{class:'table'},
    h('thead',{},h('tr',{},headers.map(title=>h('th',{scope:'col'},title)))),
    h('tbody',{},rows.map(cells=>h('tr',{},cells.map(value=>h('td',{},value))))));
}
function durationChart(){
  const points=[{x:25,y:16,value:8},{x:110,y:42,value:6},{x:195,y:55,value:5}];
  const line=svg([['polyline',{points:points.map(p=>p.x+','+p.y).join(' '),fill:'none',stroke:'currentColor','stroke-width':2}],
    ...points.map(p=>['circle',{cx:p.x,cy:p.y,r:4,fill:'currentColor'}])]);
  line.setAttribute('viewBox','0 0 220 78');line.setAttribute('width','100%');line.setAttribute('height','108');
  line.removeAttribute('aria-hidden');line.setAttribute('role','img');line.setAttribute('aria-label','测试耗时依次为 8、6、5 分钟');
  return h('div',{class:'stack'},h('strong',{},'最近一次 5 分钟，比第一次减少 3 分钟。'),line,
    table(['测试次数','耗时（分钟）'],points.map((p,i)=>['第 '+(i+1)+' 次',p.value])));
}

export function openAssistantCardExamples(){
  const picker=h('select',{},examples.map(([value,label])=>h('option',{value},label)));
  const card=h('section',{class:'card card__body stack','aria-label':'卡片预览'});
  const fallback=h('p',{class:'mailbox-content'}),feedback=h('p',{role:'status',class:'mailbox-content'});
  const reset=Button({label:'重置示例',size:'sm',onClick:draw});
  const drawer=openDrawer({title:'助理卡片示例',subtitle:'在此试用卡片，操作结果仅显示在预览中。',body:[
    field('示例类型',picker),card,feedback,reset,h('section',{},h('h3',{},'纯文字回退'),fallback)]});
  const describe=text=>{feedback.textContent=text;reset.hidden=!text;};
  function draw(){
    describe('');
    switch(picker.value){
      case 'decision':
        replace(card,h('h3',{},'选择方案'),choices.map((item,i)=>h('div',{class:'row row--wrap'},
          Button({label:item.name,onClick:()=>describe('将回复「选 '+item.name.slice(0,1)+'：'+item.name.slice(2)+'」')}),
          h('small',{},item.estimate),i===1 && Pill('推荐','ok'))));
        fallback.textContent='推荐 B 队列去重，预计半天。A 重写同步层需要 3 天，C 增加监控需要 1 小时。';
        break;
      case 'compare':
        replace(card,h('h3',{},'方案对比'),table(['方案','耗时','风险','建议'],choices.slice(0,2).map(item=>[item.name,item.estimate,item.risk,item.recommendation])),
          Button({label:'详细依据',onClick:()=>describe('将打开卡片内的「详细依据」页。推荐先为队列增加去重，减少重复处理。')}));
        fallback.textContent='方案 A 用时 3 天，改动较大。方案 B 用时半天，改动较小，建议优先选择。';
        break;
      case 'progress':{
        const version=h('select',{},h('option',{value:'before'},'更新前'),h('option',{value:'after'},'更新后'));
        const details=h('div',{class:'stack'});
        function update(){
          const done=version.value==='after',count=done?3:1;
          const states=['已完成',done?'已完成':'进行中',done?'已完成':'未开始'];
          replace(details,h('strong',{},'完成 '+count+' / 3 步，剩余 '+(3-count)+' 步'),
            h('progress',{value:count,max:3,'aria-label':'发布进度'}),
            h('ul',{},['构建','测试','部署'].map((step,i)=>h('li',{},step+' · '+states[i]))));
          fallback.textContent=done?'发布完成，构建、测试和部署 3 步均已完成。':'已完成 1 / 3 步。构建已完成，测试进行中，部署未开始。';
        }
        version.onchange=update;update();replace(card,h('h3',{},'发布进度'),field('进度版本',version),details);
        break;
      }
      case 'form':{
        const name=h('input',{class:'input',placeholder:'例如：整理读书笔记',maxLength:160}),priority=h('select',{},
          h('option',{value:'normal'},'普通'),h('option',{value:'high'},'高'));
        const notify=h('input',{type:'checkbox',checked:true});
        const form=h('form',{class:'stack',onsubmit:event=>{
          event.preventDefault();
          describe(['将回复「按这些信息安排任务」','任务名称：'+(name.value.trim() || '未填写'),
            '优先级：'+priority.selectedOptions[0].textContent,'完成后通知：'+(notify.checked?'是':'否')].join('\n'));
        }},field('任务名称',name),field('优先级',priority),h('label',{class:'check'},notify,'完成后通知'),Button({label:'提交',type:'submit'}));
        replace(card,h('h3',{},'补充任务信息'),form);
        fallback.textContent='请填写任务名称、优先级和完成后是否通知。请使用示例内容。';
        break;
      }
      case 'chart':
        replace(card,h('h3',{},'测试耗时趋势'),durationChart());
        fallback.textContent='三次测试依次耗时 8、6、5 分钟，最近一次比第一次减少 3 分钟。';break;
      case 'html':
        fallback.textContent='交互说明可展开查看细节；选择继续讨论时，需要在对话中确认。';
        replace(card,h('h3',{},'交互说明'),h('p',{},fallback.textContent),h('small',{class:'muted'},'HTML 示例仅展示文字回退。'));break;
    }
  }
  picker.onchange=draw;draw();return drawer;
}
