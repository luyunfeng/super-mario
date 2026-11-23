import {h,replace} from '../lib/dom.js';
import {uuid} from '../lib/format.js';
import {Button} from '../ui/kit.js';
import {assistantSkillsEnabled,openAssistantSkills} from './assistant-skills.js';
import {savedPromptsActive,openSavedPrompts} from './saved-prompts.js';
import {openDrawer} from '../ui/overlay.js';

export function createAssistantSwitcher({api,store,router,scope,target}){
  let drawer,opened;
  const mainButton=Button({label:'切换助理',size:'sm',onClick:open});
  const threadButton=Button({label:'切换助理',size:'sm',onClick:open});
  function allowed(){
    const view=store.view;
    return view.snapshotOwner===api.draftOwner() && !view.unauthorized &&
      ['assistant-profile','web-conversations'].every(id=>view.snapshot?.plugins?.some(p=>p.id===id && p.status==='active'));
  }
  function mainLabel(){
    const profile=store.view.snapshot?.mainAssistant;
    return profile?.revision && profile.name !== '主助手' ? '主助手 · '+profile.name : '主助手';
  }
  function update(){
    const here=target(),enabled=allowed() && !!here;
    mainButton.hidden=!enabled;threadButton.hidden=!enabled;
    if(drawer)for(const control of drawer.body.querySelectorAll('[data-roster-skills]'))control.hidden=!assistantSkillsEnabled(store);
    if(drawer)for(const control of drawer.body.querySelectorAll('[data-roster-prompts]'))control.hidden=!savedPromptsActive(store);
    if(drawer && (!enabled || opened.owner!==api.draftOwner() || opened.projectId!==here.projectId || opened.threadId!==here.threadId))drawer.close();
    else if(drawer){
      opened.updateModel();
      if(opened.mainLabel!==mainLabel())opened.paint();
    }
  }
  function open(){
    const here=target();if(!here || !allowed() || drawer)return;
    const owner=api.draftOwner(),title=h('input',{class:'input',required:true,maxLength:80,'aria-label':'助理名称'});
    const instructions=h('textarea',{class:'textarea',rows:4,maxLength:4000,'aria-label':'助理指令'});
    const choices=h('div',{class:'stack'}),status=h('p',{role:'status',class:'small muted'});
    const modelNotice=h('p',{class:'small muted'});
    function updateModel(){
      const {connection,snapshot}=store.view;
      const reason=connection!=='online' ? '连接中断，模型状态待核对。'
        : snapshot?.agent?.available===false ? '工作台模型暂不可用：'+(snapshot.agent.reason || '请在 Agent 页核对模型配置。') : '';
      modelNotice.hidden=!reason;
      if(modelNotice.textContent!==reason)modelNotice.textContent=reason;
    }
    updateModel();
    const create=h('button',{type:'submit',class:'btn btn--primary'},'创建并打开助理');
    const caption=h('summary',{},'新建助理'),latest=h('div',{class:'stack'});
    const cancel=Button({label:'取消编辑',onClick:()=>finishEdit()});cancel.hidden=true;
    let busy=false,candidate,editing,items=[],creation;
    function edit(row){
      if(!editing)creation={name:title.value,text:instructions.value,open:editor.open};
      editing=row;title.value=row.name;instructions.value=row.instructions;
      caption.textContent='编辑助理';create.textContent='保存助理资料';cancel.hidden=false;
      status.textContent='';replace(latest);editor.open=true;title.focus();
    }
    function finishEdit(){
      if(!editing)return;
      editing=null;title.value=creation.name;instructions.value=creation.text;
      caption.textContent='新建助理';create.textContent='创建并打开助理';cancel.hidden=true;
      replace(latest);editor.open=creation.open;creation=null;
    }
    function current(){
      const now=target();
      return drawer===view && view.el.open && allowed() && api.draftOwner()===owner && !!now && here.projectId===now.projectId && here.threadId===now.threadId;
    }
    async function run(action){
      if(busy || !current())return;
      busy=true;status.textContent='';
      for(const node of view.el.querySelectorAll('form button,form input,form textarea,.roster-choices button'))node.disabled=true;
      try{await action();}
      catch(error){if(current())status.textContent=error.message;}
      finally{
        busy=false;
        if(current())for(const node of view.el.querySelectorAll('form button,form input,form textarea,.roster-choices button'))node.disabled=false;
      }
    }
    async function activate(id){
      const result=await api.post('/assistant-roster',{action:'open',id,...(here.projectId && {projectId:here.projectId})});
      if(!current())return;
      if(!/^[\da-f]{8}-[\da-f]{4}-4[\da-f]{3}-[89ab][\da-f]{3}-[\da-f]{12}$/.test(result?.threadId))
        throw Error('未收到助理对话的有效回执，请重试。');
      view.close();router.go('#chat?'+new URLSearchParams({thread:result.threadId}));
    }
    async function list(){
      const result=await api.post('/assistant-roster',{action:'list'});
      if(!current())return;
      items=result.items;paint();
    }
    function paint(){
      const primary=mainLabel();
      opened.mainLabel=primary;
      const counts=new Map([[primary,1]]);
      for(const row of items)counts.set(row.name,(counts.get(row.name) || 0)+1);
      replace(choices,Button({label:primary,onClick:()=>{
        if(busy || !current())return;
        view.close();scope.set(here.projectId || '');router.go('#chat');
      }}),items.map(row=>{
        const label=counts.get(row.name)>1?row.name+' · '+row.id:row.name;
        return h('div',{class:'row'},Button({label,onClick:()=>run(()=>activate(row.id))}),
          h('button',{type:'button',class:'btn btn--sm','aria-label':'编辑 '+label,onclick:()=>edit(row)},'编辑'),
          h('button',{type:'button',class:'btn btn--sm','data-roster-skills':'',hidden:!assistantSkillsEnabled(store),
            'aria-label':'管理 '+label+' 的技能',onclick:()=>{if(current() && !busy)openAssistantSkills({api,store,assistant:row,scopeCurrent:current,onUnauthorized:view.close});}},'管理技能'),
          h('button',{type:'button',class:'btn btn--sm','data-roster-prompts':'',hidden:!savedPromptsActive(store),
            'aria-label':'管理 '+label+' 的常用提示词',onclick:()=>{if(current() && !busy)openSavedPrompts({api,store,assistantId:row.id,assistantName:row.name,isCurrent:current});}},'常用提示词'));
      }));
    }
    async function saveEdit(name,instructions){
      const {id,revision=0}=editing;
      try{
        const saved=await api.post('/assistant-roster',{action:'update',id,revision,name,instructions});
        if(!current())return;
        if(saved?.id!==id || !Number.isSafeInteger(saved.revision))throw Error('未取得助理资料更新回执。');
        items=items.map(row=>row.id===id?saved:row);paint();finishEdit();status.textContent='已保存助理资料。';
      }catch(error){
        if(error.status!==409)throw error;
        await list();
        if(!current())return;
        const saved=items.find(row=>row.id===id);
        if(!saved){finishEdit();throw Error('当前助理已不可用。');}
        editing=saved;
        replace(latest,h('strong',{},'当前已保存的资料'),h('p',{},saved.name),h('pre',{},saved.instructions || '未设置助理指令'));
        status.textContent='助理资料已变化。请核对已保存的资料和你的草稿后，再决定是否保存。';
      }
    }
    const form=h('form',{class:'stack',onsubmit:event=>{event.preventDefault();void run(async()=>{
      const name=title.value.trim(),text=instructions.value.trim();
      if(!name || [...name].length>40)throw Error('请输入 1 至 40 个字符的助理名称。');
      if([...text].length>2000)throw Error('助理指令最多 2000 个字符。');
      if(editing){await saveEdit(name,text);return;}
      if(candidate?.name!==name || candidate.instructions!==text)candidate={id:uuid(),name,instructions:text};
      await api.post('/assistant-roster',{action:'create',...candidate});
      if(!current())return;
      await activate(candidate.id);
    });}},h('label',{class:'field'},'助理名称',title),
    h('label',{class:'field'},'助理指令',instructions),latest,h('div',{class:'row'},create,cancel));
    const editor=h('details',{},caption,form);
    choices.classList.add('roster-choices');
    const view=openDrawer({title:'切换助理',body:[modelNotice,choices,status,editor],
      onClose:()=>{if(drawer===view){drawer=null;opened=null;}}});
    drawer=view;opened={...here,owner,paint,updateModel,mainLabel:mainLabel()};
    void run(list);
  }
  update();return {mainButton,threadButton,update};
}
