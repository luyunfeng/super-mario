import type {JsonObject,Store} from '../packages/plugin-sdk/src/index.ts';
import type {Project,Run,Todo,MachineInfo,ExecutionReviewEvidence} from '../packages/protocol/src/index.ts';

const lanes=['needs_you','working','review','planned','idle'] as const;
type Lane=typeof lanes[number];
type Card={id:string;projectId:string;pinned:boolean;archived:boolean};
type State={lane:Lane;reason:string};
type Item=State & {kind:'card'|'run'|'todo';id:string;title:string;projectId?:string;runId?:string;updatedAt?:string;pinned?:boolean};
export type ReviewForRun=(run:Run)=>ExecutionReviewEvidence|undefined;
export type RunBlockers=()=>(run:Run)=>readonly unknown[];

const state=(lane:Lane,reason:string):State=>({lane,reason});
const time=(value:string|undefined)=>Date.parse(value??'')||0;
const latest=(a:string|undefined,b:string|undefined)=>time(b)>time(a)?b:a;
const rank=(item:Item)=>lanes.indexOf(item.lane);
const compare=(a:Item,b:Item)=>rank(a)-rank(b) || time(b.updatedAt)-time(a.updatedAt) ||
  Number(Boolean(b.pinned))-Number(Boolean(a.pinned)) || a.title.localeCompare(b.title,'zh') || a.id.localeCompare(b.id);

function runState(run:Run,blocked:boolean,review:ExecutionReviewEvidence|undefined,superseded:boolean):State {
  if (blocked) return state('needs_you','执行有待主人处理的提问或审批');
  if (run.status==='running') return state('working','执行正在运行');
  if (run.status==='queued') return state('working','执行已排队，尚未开始');
  if (review?.status==='accepted') return state('idle','本轮执行已正式验收');
  if (superseded) return state('idle','同一待办已有后续执行，本轮已结束');
  if (review?.status==='unknown') return state('needs_you','返工派发结果未知，需排查');
  if (review?.status==='dispatching') return state('working','返工正在派发，尚未确认开始');
  if (run.status==='failed') return state('needs_you','执行失败，需排查');
  if (run.status==='unknown') return state('needs_you','执行结果未知，需排查');
  if (review?.status==='reopened') return state('idle','待办已重开，本轮为历史执行');
  if (review?.status==='invalidated') return state('review','原验收依据已变化，需要重新核对');
  if (run.status==='completed') {
    if (run.resultSource==='demo') return state('review','演示执行已返回，不能据此确认实际完成');
    if (!run.resultSource || !run.output?.trim() || ['screen','runner','terminal-idle','idle','unknown'].includes(run.resultSource.toLowerCase()) ||
        (run.resultSource!=='real' && !run.nativeResultSources?.includes(run.resultSource)))
      return state('review','执行记录标记为完成，缺少可核实的完成凭据');
    return state('review',review?.status==='pending'?'已提交执行验收，待核对':'执行已报告完成，结果待核对');
  }
  return state('idle','执行已取消');
}
function compactTitle(value:string) {
  const line=value.split(/[\r\n]/,1)[0].trim(), chars=Array.from(line);
  return chars.length>120 ? chars.slice(0,119).join('')+'…' : line;
}

export function readBoardFlow(store:Store,cards:Card[],input:JsonObject,decisionTodoIds:()=>string[],
  reviewForRun:ReviewForRun,runBlockers:RunBlockers,defaultLimit:number) {
  const machine=input.machineId;
  const archived=input.archived??false,query=input.query??'',offset=input.offset??0,limit=input.limit??defaultLimit;
  if (Object.keys(input).some(k=>!['archived','query','lane','machineId','offset','limit'].includes(k)) ||
      (machine!==undefined && (typeof machine!=='string' || !machine.trim() || machine.length>256)) ||
      typeof archived!=='boolean' || typeof query!=='string' || Array.from(query).length>500 ||
      typeof offset!=='number' || !Number.isSafeInteger(offset) || offset<0 ||
      typeof limit!=='number' || !Number.isSafeInteger(limit) || limit<1 || limit>100 ||
      (input.lane!==undefined && !lanes.some(l=>l===input.lane)) ||
      Object.values(input).some(value=>value===null)) throw Object.assign(Error('动态看板筛选或分页参数无效'),{status:400});

  const projects=new Map(store.list<Project>('projects').map(p=>[p.id,p]));
  const todos=new Map(store.list<Todo>('todos').map(t=>[t.id,t]));
  const cardProjects=new Set(cards.map(c=>c.projectId));
  const visibleCards=cards.filter(c=>c.archived===archived && (!machine || projects.get(c.projectId)?.workspace?.machineId===machine) && projects.has(c.projectId) && (archived || !projects.get(c.projectId)?.archivedAt));
  const visibleCardProjects=new Set(visibleCards.map(c=>c.projectId));
  const visibleProject=(id:string|undefined)=>!id || (projects.has(id) && !projects.get(id)?.archivedAt);
  const runs=store.list<Run>('runs').filter(run=>(archived ? !!run.projectId && visibleCardProjects.has(run.projectId) : visibleProject(run.projectId)) &&
    (!run.todoId || (todos.has(run.todoId) && todos.get(run.todoId)?.projectId===run.projectId)));
  const latestRun=new Map<string,Run>();
  for (const r of runs) if (r.todoId && time(r.createdAt)>=time(latestRun.get(r.todoId)?.createdAt)) latestRun.set(r.todoId,r);
  const blocked=runBlockers(), blockedIds=new Set<string>(),acceptedIds=new Set<string>();
  const runMap=new Map(runs.map(r=>[r.id,r]));
  const machines=new Map(store.list<MachineInfo>('machines').map(m=>[m.id,m.name]));
  // Within needs_you, an explicit pending decision takes focus before an unrelated failed run.
  const focusOrder=(a:Item,b:Item)=>rank(a)-rank(b) || Number(blockedIds.has(b.id))-Number(blockedIds.has(a.id)) || compare(a,b);
  const byProject=new Map<string,Item[]>(),byTodo=new Map<string,Item[]>(),items:Item[]=[];
  function addTo(map:Map<string,Item[]>,id:string,value:Item) {
    const bucket=map.get(id);
    if (bucket) bucket.push(value); else map.set(id,[value]);
  }
  for (const run of runs) {
    const todo=run.todoId ? todos.get(run.todoId) : undefined;
    const review=reviewForRun(run);
    const pending=(run.status==='queued' || run.status==='running') && blocked(run).length>0;
    if (pending) blockedIds.add(run.id);
    if (review?.status==='accepted') acceptedIds.add(run.id);
    const next=runState(run,pending,review,!!todo && latestRun.get(todo.id)?.id!==run.id);
    const activity=latest(run.updatedAt,review?.updatedAt);
    const item:Item={kind:'run',id:run.id,runId:run.id,title:compactTitle(run.prompt) || todo?.title || '执行记录',
      ...next,...(activity && {updatedAt:activity}),...(run.projectId && {projectId:run.projectId})};
    if (run.projectId && visibleCardProjects.has(run.projectId)) addTo(byProject,run.projectId,item);
    if (todo) addTo(byTodo,todo.id,item);
    if ((!machine || machine===run.machineId) && !archived && (!run.projectId || !cardProjects.has(run.projectId))) items.push(item);
  }
  for (const card of visibleCards) {
    const group=byProject.get(card.projectId)??[],focus=group.sort(focusOrder)[0];
    const updatedAt=group.reduce<string|undefined>((date,item)=>latest(date,item.updatedAt),undefined);
    items.push({kind:'card',id:card.id,title:projects.get(card.projectId)!.name,projectId:card.projectId,pinned:card.pinned,
      lane:focus?.lane??'idle',reason:focus?.reason??'项目暂无关联执行',...(focus && {runId:focus.id}),...(updatedAt && {updatedAt})});
  }
  if (!archived) {
    const decisions=new Set(decisionTodoIds());
    for (const todo of todos.values()) {
      if (!visibleProject(todo.projectId)) continue;
      const associated=byTodo.get(todo.id)??[], assignment=todo.responsibleSession;
      let matching=associated;
      if (machine) {
        matching=associated.filter(item=>runMap.get(item.id)?.machineId===machine);
        if (!matching.length && assignment?.machineId!==machine) continue;
      }
      const focus=matching.sort(focusOrder)[0];
      let next:State;
      if (todo.completedAt) next=state('idle','待办已完成');
      else if (decisions.has(todo.id)) next=state('needs_you','待办有待主人处理的决定');
      else if (focus && focus.lane!=='idle') next=focus;
      else if (focus && acceptedIds.has(focus.id)) next=state('idle','本轮执行已正式验收');
      else next=state('planned',todo.waitingOn?.trim()?'待办已登记等待事项':'待办尚无进行中的执行');
      const activity=latest(todo.updatedAt,focus?.updatedAt);
      items.push({kind:'todo',id:todo.id,title:todo.title,lane:next.lane,reason:next.reason,...(todo.projectId && {projectId:todo.projectId}),
        ...(focus && {runId:focus.id}),...(activity && {updatedAt:activity})});
    }
  }
  const counts={needs_you:0,working:0,review:0,planned:0,idle:0};
  const term=query.trim().toLocaleLowerCase();
  const selected=items.filter(item=>{
    if (term) {
      const project=item.projectId ? projects.get(item.projectId) : undefined;
      const run=item.runId ? runMap.get(item.runId) : undefined;
      const todo=item.kind==='todo' ? todos.get(item.id) : undefined;
      const ids=item.kind==='card' ? [project?.workspace?.machineId] : item.kind==='run' ? [run?.machineId] :
        [todo?.responsibleSession?.machineId,...(byTodo.get(item.id)??[]).map(r=>runMap.get(r.id)?.machineId)];
      const fields=[item.title,project?.name,todo?.notes,todo?.responsiblePerson,
        item.kind==='card'?project?.workspace?.cwd:run?.cwd,run?.executorId,...ids.flatMap(id=>id?[id,machines.get(id)]:[])];
      if (!fields.some(text=>text?.toLocaleLowerCase().includes(term))) return false;
    }
    counts[item.lane]++;
    return !input.lane || item.lane===input.lane;
  }).sort(compare);
  return {counts,items:selected.slice(offset,offset+limit),
    nextOffset:offset+limit<selected.length?offset+limit:null};
}
