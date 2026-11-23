import {h,replace} from '../lib/dom.js';
import {Button,Field,Input,Select,TextArea} from '../ui/kit.js';
import {openDrawer,toast} from '../ui/overlay.js';

const fields=[['prompt','执行内容'],['doneWhen','完成标准'],['executorId','执行者'],['model','本次执行模型'],['cwd','工作目录'],['expectMinutes','预计分钟']];

export function createPlanEditor(api,store){
  const drafts=new Map();
  let owner,open;
  return function editPlan(item){
    if(open?.el.open)return;
    const identity=api.draftOwner(),route=location.hash;
    if(!identity || store.view.unauthorized || store.view.snapshotOwner!==identity)return;
    if(owner!==identity){drafts.clear();owner=identity;}
    const id=item.id.slice('plan:'.length),key=JSON.stringify([id,item.version]);
    const status=h('p',{role:'status',class:'small'}),body=h('div',{class:'stack'});
    let plan,inputs,busy=false;
    const submit=Button({label:'确认并开始执行',kind:'primary',onClick:start});
    submit.disabled=true;
    const drawer=openDrawer({title:'修改待执行计划',subtitle:item.title,wide:true,body:[body,status],footer:[
      Button({label:'关闭',onClick:()=>drawer.close(),ariaLabel:'保留草稿并关闭'}),submit],
      onClose(){off();window.removeEventListener('hashchange',check);if(open===drawer)open=null;}});
    open=drawer;
    const valid=()=>drawer.el.open && location.hash===route && identity===api.draftOwner() && !store.view.unauthorized && store.view.snapshotOwner===identity;
    function check(){if(!valid()){if(owner!==api.draftOwner() || store.view.unauthorized)drafts.clear();drawer.close();}}
    const off=store.subscribe(check);window.addEventListener('hashchange',check);
    function remember(){drafts.set(key,inputs.map(row=>Object.fromEntries(fields.map(([name])=>[name,row[name].value]))));}
    async function load(){
      status.textContent='正在读取计划…';
      try{
        const plans=await api.get('/plans');
        if(!valid())return;
        for(const cached of drafts.keys()){
          const [planId,version]=JSON.parse(cached);
          if(!plans.some(p=>p.id===planId && p.version===version && p.status==='pending'))drafts.delete(cached);
        }
        plan=plans.find(p=>p.id===id && p.status==='pending' && p.version===item.version);
        if(!plan){status.textContent='原计划已变更或已处理，请关闭后核对。';store.refresh();return;}
        const cached=drafts.get(key);
        inputs=plan.tasks.map((task,index)=>Object.fromEntries(fields.map(([name])=>{
          const value=cached?.[index]?.[name] ?? task[name] ?? '';
          if(name==='executorId'){
            const snapshot=store.view.snapshot;
            const machine=snapshot.projects?.find(p=>p.id===task.projectId)?.workspace?.machineId;
            const options=(snapshot.executors || []).filter(e=>e.available && (!machine || e.machineId===machine && e.mode==='real'))
              .map(e=>[e.id,e.name || e.id]);
            if(!task.executorId)options.unshift(['','使用默认执行者']);
            for(const saved of [task.executorId,value])if(saved && !options.some(([id])=>id===saved))options.push([saved,saved+'（当前不可用）']);
            return [name,Select({options,value,onchange:remember})];
          }
          return [name,name==='prompt' || name==='doneWhen' ? TextArea({value,rows:2,oninput:remember}) :
            Input({value,type:name==='expectMinutes'?'number':'text',step:name==='expectMinutes'?'any':undefined,
              placeholder:name==='model'?'留空使用执行者默认模型':name==='cwd'?'使用默认工作目录':undefined,oninput:remember})];
        })));
        replace(body,inputs.map((row,index)=>h('fieldset',{class:'stack'},h('legend',{},'任务 '+(index+1)),
          plan.tasks[index].projectId && h('p',{class:'small muted'},'项目：'+(store.view.snapshot.projects?.find(p=>p.id===plan.tasks[index].projectId)?.name || plan.tasks[index].projectId)),
          plan.tasks[index].todoId && h('p',{class:'small muted'},'待办：'+(store.view.snapshot.todos?.find(t=>t.id===plan.tasks[index].todoId)?.title || plan.tasks[index].todoId)),
          fields.map(([name,label])=>Field({label,control:row[name]})))));
        status.textContent=cached?'已恢复未提交的修改。':'关闭后可在本页重新打开，继续编辑。';
        submit.disabled=false;
      }catch(e){if(valid())replace(status,'读取失败：'+e.message+' ',Button({label:'重新读取',onClick:load}));}
    }
    async function start(){
      if(!valid() || !plan || busy || submit.disabled)return;
      const edits=[];
      for(const [index,controls] of inputs.entries()){
        const original=plan.tasks[index],edit={index};
        for(const [name,label] of fields){
          const control=controls[name],raw=control.value.trim();
          if(raw===String(original[name] ?? '').trim())continue;
          if(!raw && name!=='model' || name==='cwd' && (!raw.startsWith('/') || /[\x00-\x1f\x7f]/.test(raw)) ||
            name==='expectMinutes' && (!Number.isFinite(Number(raw)) || Number(raw)<=0 || Number(raw)>10080)){
            status.textContent='任务 '+(index+1)+'：'+(!raw?label+'不能为空。':name==='cwd'?'工作目录需要绝对路径。':'预计分钟须大于 0 且不超过 10080。');
            control.focus();return;
          }
          if(name==='expectMinutes' && Number(raw)===original[name])continue;
          edit[name]=name==='expectMinutes'?Number(raw):raw;
        }
        if(Object.keys(edit).length>1)edits.push(edit);
      }
      busy=true;submit.disabled=true;body.querySelectorAll('fieldset').forEach(node=>{node.disabled=true;});
      try{
        const result=await api.post('/plans/'+encodeURIComponent(id)+'/start',{version:item.version,...(edits.length && {edits})});
        drafts.delete(key);
        if(valid()){
          drawer.close();
          toast(result.status==='started'?'计划已派发。':result.status==='partial'?'计划仅部分派发，请查看执行记录。':'派发结果待核对，请查看执行记录。');
        }
      }catch(error){
        if(valid()){
          const uncertain=!error.status || error.status>=500 || error.status===409;
          status.textContent=uncertain?'尚未确认派发结果，请关闭后重新打开核对。'+error.message:'未能派发：'+error.message;
          submit.disabled=uncertain;
          body.querySelectorAll('fieldset').forEach(node=>{node.disabled=uncertain;});
        }
      }finally{busy=false;store.refresh();}
    }
    void load();
  };
}
