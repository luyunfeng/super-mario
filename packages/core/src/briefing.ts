import type { Store } from '../../plugin-sdk/src/index.ts';
import type { Project, Run, Todo, Approval, BriefingSettings } from '../../protocol/src/index.ts';
import type { createSchedules } from './schedules.ts';

const defaults: BriefingSettings = { decisionQuietHours: { enabled:false, start:'22:00', end:'08:00' }, timezone:'Asia/Shanghai', morning:'09:00', evening:'18:00', intervalHours:4, intervalEnabled:false, activeStart:'09:00', activeEnd:'21:00', awayNotifications:true };
const clock = (s: unknown): s is string => typeof s === 'string' && /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(s);
export function buildWindowBrief(store: Store, from: string, to: string, projectId?: string, conversations: readonly import('../../protocol/src/inbox-conversations.ts').InboxConversation[] = [], morningTimezone?: string, includeContinuingRuns = false) {
  if (!Number.isFinite(Date.parse(from)) || !Number.isFinite(Date.parse(to)) || Date.parse(from) >= Date.parse(to)) throw new Error('摘要时间窗无效');
  const changed = (date: string) => Date.parse(date) > Date.parse(from) && Date.parse(date) <= Date.parse(to);
  const beforeEnd = (date: string) => Date.parse(date) <= Date.parse(to);
  // An old todo can become urgent without any change in the reporting window.
  const cutoff = Date.parse(to);
  const localDate = morningTimezone ? new Intl.DateTimeFormat('en-CA', {
    timeZone: morningTimezone, year: 'numeric', month: '2-digit', day: '2-digit',
  }) : undefined;
  const morningDate = localDate?.format(cutoff);
  const projects = store.list<Project>('projects').filter(p => !p.archivedAt && (projectId === undefined || p.id === projectId));
  const runs = store.list<Run>('runs');
  const todos = store.list<Todo>('todos');
  const approvals = store.list<Approval>('approvals').filter(a => a.status === 'pending' && beforeEnd(a.createdAt));
  const cards = store.list<{id:string;title:string;projectId?:string;status:string;createdAt:string}>('interactions').filter(c => c.status === 'open' && beforeEnd(c.createdAt));
  const plans = store.list<{id:string;title:string;status:string;createdAt:string;tasks:{projectId?:string}[]}>('plans').filter(p => p.status === 'pending' && beforeEnd(p.createdAt));
  return { from, to, basis:'持久记录的最新状态；执行结束不代表待办验收完成。待决定包含此前积压。', projects:[...projects.map(p => ({id:p.id,name:p.name})),...(projectId === undefined ? [{id:'',name:'未归项目'}] : [])].map(project => {
    const scopedRuns = runs.filter(r => (r.projectId ?? '') === project.id);
    const scopedTodos = todos.filter(t => (t.projectId ?? '') === project.id);
    // The briefing queue starts when the question becomes a todo. The todo outlives its seven days in briefings.
    const deferredQuestions = scopedTodos.filter(todo => todo.deferredQuestion && !todo.completedAt
      && beforeEnd(todo.createdAt) && cutoff - Date.parse(todo.createdAt) < 7 * 86400000)
      .sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt) || a.id.localeCompare(b.id))
      .map(todo => ({ id: todo.id, title: todo.title }));
    const overdue: { id: string; title: string; dueAt: string; dueDay?: string }[] = [];
    const dueToday: typeof overdue = [];
    if (localDate) {
      for (const todo of scopedTodos) {
        if (!todo.dueAt || todo.completedAt || !beforeEnd(todo.createdAt)) continue;
        const time = Date.parse(todo.dueAt);
        if (!Number.isFinite(time)) continue;
        const item = { id: todo.id, title: todo.title, dueAt: todo.dueAt, ...(todo.dueDay && { dueDay: todo.dueDay }) };
        if (time < cutoff) overdue.push(item);
        else if ((todo.dueDay ?? localDate.format(time)) === morningDate) dueToday.push(item);
      }
      for (const group of [overdue, dueToday]) {
        group.sort((a, b) => Date.parse(a.dueAt) - Date.parse(b.dueAt) || a.id.localeCompare(b.id));
      }
    }
    const updates = (status: Run['status']) => scopedRuns.filter(r => changed(r.updatedAt) && r.status === status)
      .map(r => ({ id: r.id, title: r.prompt, status: r.status }));
    return { projectId:project.id, name:project.name, deferredQuestions,
      ...(localDate ? { overdue, dueToday } : {}),
      ...(includeContinuingRuns ? { continuing: scopedRuns
        .filter(r => r.status === 'running' && Date.parse(r.updatedAt) <= Date.parse(from))
        .map(r => ({ id: r.id, title: r.prompt, updatedAt: r.updatedAt })) } : {}),
      progress: updates('running'), queued: updates('queued'), unknown: updates('unknown'), cancelled: updates('cancelled'),
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
export function formatDeferredQuestions(brief: ReturnType<typeof buildWindowBrief>, name: string, alreadyShown = '') {
  if (name !== 'morning' && name !== 'evening') return '';
  const rows: string[] = [];
  for (const project of brief.projects) {
    const items = project.deferredQuestions;
    if (!items?.length) continue;
    const titles = items.slice(0, 20).map(item => item.title.slice(0, 200));
    const label = project.name + ' · 可稍后回答';
    if (alreadyShown.includes(label) && titles.every(title => alreadyShown.includes(title))) continue;
    rows.push(label + ' ' + items.length + '：' + titles.join('；') + (items.length > 20 ? '；其余请在工作台查看' : ''));
  }
  return rows.join('\n');
}
export function formatWindowBrief(brief: ReturnType<typeof buildWindowBrief> & { overdue?: {id:string;title:string}[] }, name: string, timezone='Asia/Shanghai') {
  const date=new Intl.DateTimeFormat('zh-CN',{timeZone:timezone,month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hourCycle:'h23'});
  const rows=[`工作台${({morning:'早间',evening:'晚间',interval:'间隔',project:'项目'} as Record<string,string>)[name]||''}简报`,`${date.format(new Date(brief.from))} — ${date.format(new Date(brief.to))}（${timezone}）`];
  let changed=false;
  for(const p of brief.projects){
    const sections=[['待你决定',p.decisions],['逾期待办',p.overdue ?? []],['今日到期',p.dueToday ?? []],['执行失败',p.failed],['执行结果未知',p.unknown],['执行已取消',p.cancelled],['等待执行',p.queued],['已完成待办',p.completed],['执行结束，待验收',p.ended],['进行中',p.progress],['仍记录为运行中，本期无更新',p.continuing ?? []],['事项更新',p.todoUpdates]] as const;
    const nonempty=sections.filter(([,items])=>items.length);if(!nonempty.length)continue;changed=true;rows.push(`\n${p.name}`);
    for (const [label, items] of nonempty) {
      const titles = items.slice(0, 20).map(item => {
        const title = item.title.slice(0, 200);
        if ('updatedAt' in item && typeof item.updatedAt === 'string') return title + '（最后更新 ' + date.format(new Date(item.updatedAt)) + '）';
        if ('dueDay' in item && typeof item.dueDay === 'string') return title + '（' + item.dueDay + ' 全天）';
        if ('dueAt' in item && typeof item.dueAt === 'string') return title + '（' + date.format(new Date(item.dueAt)) + '）';
        if ('error' in item && typeof item.error === 'string') return title + '：' + item.error.slice(0, 200);
        if ('result' in item && typeof item.result === 'string') return title + '：' + item.result.slice(0, 200);
        return title;
      });
      rows.push(label + ' ' + items.length + '：' + titles.join('；') + (items.length > 20 ? '；其余请在工作台查看' : ''));
    }
  }
  if(brief.overdue?.length){changed=true;rows.push(`\n逾期待办 ${brief.overdue.length}：`+brief.overdue.slice(0,20).map(t=>t.title.slice(0,200)).join('；'));}
  const deferred = formatDeferredQuestions(brief, name);
  if (deferred) { changed = true; rows.push('\n' + deferred); }
  if(!changed)rows.push('本期暂无新的工作变化，也没有待决定事项。');
  return rows.join('\n');
}
export function readBriefingSettings(store: Pick<Store, 'get'>): BriefingSettings {
  return { ...defaults, ...store.get<BriefingSettings>('briefing.settings', 'default') };
}

export function createBriefingSettings(store: Store, schedules: ReturnType<typeof createSchedules>) {
  const settings = () => readBriefingSettings(store);
  function configure(patch: Partial<BriefingSettings>) {
    if (!patch || typeof patch !== 'object' || Array.isArray(patch) || Object.keys(patch).some(k => !(k in defaults))) throw new Error('简报配置包含未知字段');
    const old = settings(), next = {...old,...patch};
    const quiet = next.decisionQuietHours;
    if (!quiet || typeof quiet.enabled !== 'boolean' || !clock(quiet.start) || !clock(quiet.end)
      || Object.keys(quiet).some(key => !['enabled','start','end'].includes(key))) throw new Error('请填写有效的飞书待决定提醒免打扰时段');
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
