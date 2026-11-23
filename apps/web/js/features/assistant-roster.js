import {h,replace} from '../lib/dom.js';
import {uuid} from '../lib/format.js';
import {Button} from '../ui/kit.js';
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
  function update(){
    const here=target(),enabled=allowed() && !!here;
    mainButton.hidden=!enabled;threadButton.hidden=!enabled;
    if(drawer && (!enabled || opened.owner!==api.draftOwner() || opened.projectId!==here.projectId || opened.threadId!==here.threadId))drawer.close();
  }
  function open(){
    const here=target();if(!here || !allowed() || drawer)return;
    const owner=api.draftOwner(),title=h('input',{class:'input',required:true,maxLength:80,'aria-label':'助理名称'});
    const instructions=h('textarea',{class:'textarea',rows:4,maxLength:4000,'aria-label':'助理指令'});
    const choices=h('div',{class:'stack'}),status=h('p',{role:'status',class:'small muted'});
    const create=h('button',{type:'submit',class:'btn btn--primary'},'创建并打开助理');
    let busy=false,candidate;
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
      const counts=new Map([['主助手',1]]);
      for(const row of result.items)counts.set(row.name,(counts.get(row.name) || 0)+1);
      replace(choices,Button({label:'主助手',onClick:()=>{
        if(busy || !current())return;
        view.close();scope.set(here.projectId || '');router.go('#chat');
      }}),result.items.map(row=>Button({label:counts.get(row.name)>1?row.name+' · '+row.id:row.name,onClick:()=>run(()=>activate(row.id))})));
    }
    const form=h('form',{class:'stack',onsubmit:event=>{event.preventDefault();void run(async()=>{
      const name=title.value.trim(),text=instructions.value.trim();
      if(!name || [...name].length>40)throw Error('请输入 1 至 40 个字符的助理名称。');
      if([...text].length>2000)throw Error('助理指令最多 2000 个字符。');
      if(candidate?.name!==name || candidate.instructions!==text)candidate={id:uuid(),name,instructions:text};
      await api.post('/assistant-roster',{action:'create',...candidate});
      if(!current())return;
      await activate(candidate.id);
    });}},h('label',{class:'field'},'助理名称',title),
    h('label',{class:'field'},'助理指令',instructions),create);
    choices.classList.add('roster-choices');
    const view=openDrawer({title:'切换助理',body:[choices,status,h('details',{},h('summary',{},'新建助理'),form)],
      onClose:()=>{if(drawer===view){drawer=null;opened=null;}}});
    drawer=view;opened={...here,owner};
    void run(list);
  }
  update();return {mainButton,threadButton,update};
}
