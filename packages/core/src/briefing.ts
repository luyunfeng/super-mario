import type { Store } from '../../plugin-sdk/src/index.ts';
import type { Project, Run, Todo, Approval, BriefingSettings } from '../../protocol/src/index.ts';
import type { createSchedules } from './schedules.ts';

const defaults: BriefingSettings = { timezone:'Asia/Shanghai', morning:'09:00', evening:'18:00', intervalHours:4, intervalEnabled:false, activeStart:'09:00', activeEnd:'21:00', awayNotifications:true };
const clock = (s: unknown): s is string => typeof s === 'string' && /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(s);
export function buildWindowBrief(store: Store, from: string, to: string, projectId?: string, conversations: readonly import('../../protocol/src/inbox-conversations.ts').InboxConversation[] = []) {
  if (!Number.isFinite(Date.parse(from)) || !Number.isFinite(Date.parse(to)) || Date.parse(from) >= Date.parse(to)) throw new Error('摘要时间窗无效');
  const changed = (date: string) => Date.parse(date) > Date.parse(from) && Date.parse(date) <= Date.parse(to);
  const beforeEnd = (date: string) => Date.parse(date) <= Date.parse(to);
  const projects = store.list<Project>('projects').filter(p => !p.archivedAt && (projectId === undefined || p.id === projectId));
  const runs = store.list<Run>('runs');
  const todos = store.list<Todo>('todos');
  const approvals = store.list<Approval>('approvals').filter(a => a.status === 'pending' && beforeEnd(a.createdAt));
  const cards = store.list<{id:string;title:string;projectId?:string;status:string;createdAt:string}>('interactions').filter(c => c.status === 'open' && beforeEnd(c.createdAt));
  const plans = store.list<{id:string;title:string;status:string;createdAt:string;tasks:{projectId?:string}[]}>('plans').filter(p => p.status === 'pending' && beforeEnd(p.createdAt));
  return { from, to, basis:'持久记录的最新状态；执行结束不代表待办验收完成。待决定包含此前积压。', projects:[...projects.map(p => ({id:p.id,name:p.name})),...(projectId === undefined ? [{id:'',name:'未归项目'}] : [])].map(project => {
    const scopedRuns = runs.filter(r => (r.projectId ?? '') === project.id);
    const scopedTodos = todos.filter(t => (t.projectId ?? '') === project.id);
    return { projectId:project.id, name:project.name,
      progress: scopedRuns.filter(r => changed(r.updatedAt) && !['completed','failed','cancelled'].includes(r.status)).map(r => ({id:r.id,title:r.prompt,status:r.status})),
      todoUpdates: scopedTodos.filter(t => changed(t.updatedAt) && !t.completedAt).map(t => ({id:t.id,title:t.title})),
      completed: scopedTodos.filter(t => t.completedAt && changed(t.completedAt)).map(t => ({id:t.id,title:t.title})),
      ended: scopedRuns.filter(r => r.status === 'completed' && changed(r.updatedAt)).map(r => ({id:r.id,title:r.prompt,result:r.output.slice(0,800)})),
      failed: scopedRuns.filter(r => r.status === 'failed' && changed(r.updatedAt)).map(r => ({id:r.id,title:r.prompt,error:(r.error || r.output).slice(0,800)})),
      decisions: [...conversations.filter(c=>c.status==='waiting_user'&&(c.projectId??'')===project.id).map(c=>({id:c.id,title:`${c.title}：${c.question}`})),...cards.filter(c => (c.projectId ?? '') === project.id).map(c => ({id:c.id,title:c.title})),...approvals.filter(a => {
        const todo = a.todoId ? todos.find(t => t.id === a.todoId) : undefined;
        return (todo?.projectId ?? (typeof a.params.projectId === 'string' ? a.params.projectId : '')) === project.id;
      }).map(a => ({id:a.id,title:a.title})),...plans.filter(p => {
        const origin=store.get<{projectId?:string}>('plan-origins',p.id);
        return p.tasks.some(t => (t.projectId ?? origin?.projectId ?? '') === project.id);
      }).map(p=>({id:p.id,title:p.title}))],
    };
  }) };
}
export function formatWindowBrief(brief: ReturnType<typeof buildWindowBrief> & { overdue?: {id:string;title:string}[] }, name: string, timezone='Asia/Shanghai') {
  const date=new Intl.DateTimeFormat('zh-CN',{timeZone:timezone,month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hourCycle:'h23'});
  const rows=[`工作台${({morning:'早间',evening:'晚间',interval:'间隔',project:'项目'} as Record<string,string>)[name]||''}简报`,`${date.format(new Date(brief.from))} — ${date.format(new Date(brief.to))}（${timezone}）`];
  let changed=false;
  for(const p of brief.projects){
    const sections=[['待你决定',p.decisions],['执行失败',p.failed],['已完成待办',p.completed],['执行结束，待验收',p.ended],['进行中',p.progress],['事项更新',p.todoUpdates]] as const;
    const nonempty=sections.filter(([,items])=>items.length);if(!nonempty.length)continue;changed=true;rows.push(`\n${p.name}`);
    for(const [label,items] of nonempty)rows.push(`${label} ${items.length}：`+items.slice(0,20).map(i=>`${i.title.slice(0,200)}${'error' in i&&typeof i.error==='string'?'：'+i.error.slice(0,200):'result' in i&&typeof i.result==='string'?'：'+i.result.slice(0,200):''}`).join('；')+(items.length>20?'；其余请在工作台查看':''));
  }
  if(brief.overdue?.length){changed=true;rows.push(`\n逾期待办 ${brief.overdue.length}：`+brief.overdue.slice(0,20).map(t=>t.title.slice(0,200)).join('；'));}
  if(!changed)rows.push('本期暂无新的工作变化，也没有待决定事项。');
  return rows.join('\n');
}
export function createBriefingSettings(store: Store, schedules: ReturnType<typeof createSchedules>) {
  const settings = (): BriefingSettings => ({ ...defaults,...store.get<BriefingSettings>('briefing.settings','default') });
  function configure(patch: Partial<BriefingSettings>) {
    if (!patch || typeof patch !== 'object' || Array.isArray(patch) || Object.keys(patch).some(k => !(k in defaults))) throw new Error('简报配置包含未知字段');
    const old = settings(), next = {...old,...patch};
    if (![next.morning,next.evening,next.activeStart,next.activeEnd].every(clock) || next.activeStart >= next.activeEnd) throw new Error('请填写有效时段，开始必须早于结束');
    if (!Number.isInteger(next.intervalHours) || next.intervalHours < 1 || next.intervalHours > 168 || typeof next.intervalEnabled !== 'boolean' || typeof next.awayNotifications !== 'boolean') throw new Error('简报间隔必须为 1–168 小时，开关必须为布尔值');
    if (typeof next.timezone !== 'string') throw new Error('时区必须为 IANA 名称');
    new Intl.DateTimeFormat('en',{timeZone:next.timezone}).format();
    const api = schedules.forOwner('daily-brief');
    return store.transaction(() => {
      for (const name of ['morning','evening'] as const) {
        if (old[name] === next[name] && old.timezone === next.timezone) continue;
        const [hour,minute] = next[name].split(':');
        const spec = {name,kind:'cron' as const,cron:`${Number(minute)} ${Number(hour)} * * *`,tz:next.timezone};
        const existing = api.list().filter(s => s.name === name);
        if (existing.length) for (const schedule of existing) api.update(schedule.id,spec,schedule.version);
        else api.create(spec);
      }
      const intervals = api.list().filter(s => s.name === 'interval');
      if (next.intervalEnabled) {
        if (!intervals.length) api.create({name:'interval',kind:'interval',everySec:next.intervalHours*3600});
        else for (const s of intervals) if (old.intervalHours !== next.intervalHours || !old.intervalEnabled) api.update(s.id,{everySec:next.intervalHours*3600,...(!old.intervalEnabled?{status:'active' as const}:{})},s.version);
      } else for (const s of intervals) if (!['paused','cancelled'].includes(s.status)) api.update(s.id,{status:'paused'},s.version);
      store.put('briefing.settings','default',next);
      store.put('notifications.settings','away',{enabled:next.awayNotifications});
      return next;
    });
  }
  return { settings, configure, inActiveWindow(date: string) {
    const s = settings();
    const local = new Intl.DateTimeFormat('en-GB',{timeZone:s.timezone,hour:'2-digit',minute:'2-digit',hourCycle:'h23'}).format(new Date(date));
    return local >= s.activeStart && local < s.activeEnd;
  } };
}
