import { digest } from './eventbox.ts';
import { formatWindowBrief } from './briefing.ts';
import type { MachineClient } from '../../plugin-sdk/src/index.ts';
import type { Project, Run } from '../../protocol/src/index.ts';
import type { StoredDocument, WorkbenchStore } from './store.ts';

type Row = Record<string, unknown>;
const object = (value: unknown): Row => value && typeof value === 'object' && !Array.isArray(value) ? value as Row : {};
const fail = (message: string, status: number): never => { throw Object.assign(new Error(message), {status}); };
const connectorEvidence = new Set(['todo.reply-evidence','todo.reply-sources']);
const journal = 'core.pending-project-purges';

// Reference names have namespaces. A machine, a message and a todo may legally
// have the same id. Never search titles, text, file paths, or serialized JSON for ids.
const refs: Record<string,string> = {
  projectId:'projects', todoId:'todos', runId:'runs', previousRunId:'runs', sourceRunId:'runs', messageId:'messages',
  sourceMessageId:'messages', inputId:'messages', acceptedId:'messages', replyTo:'messages', approvalId:'approvals',
  interactionId:'interactions', cardId:'interactions', planId:'plans', jobId:'knowledge.sources', retryOf:'knowledge.sources',
  knowledgeId:'knowledge', signalId:'supervision.signals', reviewId:'supervisor.reviews', entryId:'event.mailboxes',
  parentEntryId:'event.mailboxes', scheduleId:'eventbox.schedules', workId:'scheduled-work.requests',
  resultMessageId:'messages', envelopeId:'event.mailboxes', relayEntryId:'event.mailboxes', resultRelayEntryId:'event.mailboxes', eventId:'eventbox.events', causedBy:'eventbox.events', outboxId:'outbox.items', suggestionId:'inbox-handling.suggestions',
  conversationId:'inbox-handling.conversations', decisionId:'work.decisions',
};
const kinds: Record<string,string> = {
  project:'projects',task:'todos',todo:'todos',run:'runs',message:'messages',approval:'approvals',plan:'plans',
  interaction:'interactions',signal:'supervision.signals',review:'supervisor.reviews',schedule:'eventbox.schedules',
  outbox:'outbox.items',inbox:'inbox',personal:'inbox',mailbox:'event.mailboxes',knowledge:'knowledge',
};
const keyed: Record<string,string> = {
  'project.memory':'projects','project-follow-up.grants':'projects','project-follow-up.cursors':'projects',
  'input-paused':'messages','message.routes':'messages','interaction-origins':'interactions','plan-origins':'plans',
  'run-reviews':'todos','todo.reporting':'todos','supervisor.processed':'supervision.signals',
  'background.review-cards':'supervisor.reviews','feishu.bot.envelopes':'event.mailboxes',
  'approval-followup.results':'eventbox.events','approval-followup.waiting':'eventbox.events','outbox.reply-grants':'outbox.items','inbox-handling.approvals':'approvals','knowledge.source-approvals':'knowledge.sources',
};
const eventCollections: Record<string,string> = {
  'mailboxes.changed':'event.mailboxes','notifications.created':'supervision.signals','supervisor.review':'supervisor.reviews',
  'supervision.signal':'supervision.signals','scheduled.work.changed':'scheduled-work.requests','effects.changed':'effects','work.decision.recorded':'work.decisions',
};
const nested = ['scope','subject','relatedTo','staleIf','data','payload','params','input','source','sourceMessage','result',
  'request','approval','approvalParams','dispatchParams','decision','recordSource','action','relay','inboxReplySource','binding','proof'];

class Ownership {
  private briefCopies = new Map<string,{oldHash:string;text:string}>();
  private ids = new Map<string,Set<string>>();
  readonly projectId: string;
  constructor(projectId: string, saved: [string,string[]][] = []) {
    this.projectId = projectId;
    for (const [collection, ids] of saved) this.ids.set(collection,new Set(ids));
    this.add('projects',projectId);
  }
  save(): [string,string[]][] { return [...this.ids].map(([key,values]) => [key,[...values]]); }
  has(collection: string | undefined, id: unknown) {
    return !!collection && typeof id === 'string' && this.ids.get(collection)?.has(id) === true;
  }
  add(collection: string,id: string) {
    let set = this.ids.get(collection);
    if (!set) this.ids.set(collection,set = new Set());
    if (set.has(id)) return false;
    set.add(id); return true;
  }
  typedKey(key: unknown) {
    if (typeof key !== 'string') return false;
    const i = key.indexOf(':');
    if (i < 0) return false;
    const kind = key.slice(0,i), id = key.slice(i+1);
    return this.has(kind === 'todo-reminder' ? 'todos' : kinds[kind],id);
  }
  reference(value: unknown): boolean {
    if (!value || typeof value !== 'object') return false;
    const row = object(value);
    const owner = row.projectId ?? object(row.scope).projectId;
    if (owner !== undefined) return owner === this.projectId;
    if (object(row.scope).kind === 'global') return false;
    if (row.kind === 'global' || row.layer === 'personal' || row.layer === 'global') return false;
    if (this.has(kinds[String(row.kind)],row.id) || this.typedKey(row.ref)) return true;
    if (typeof row.conversationId === 'string' && row.conversationId.startsWith('project:'+this.projectId+':')) return true;
    for (const [field,collection] of Object.entries(refs)) if (this.has(collection,row[field])) return true;
    if (this.has(kinds[String(row.decisionKind)],row.decisionId)) return true;
    for (const key of ['runIds','signalIds'] as const) {
      const ids = row[key];
      if (Array.isArray(ids) && ids.some(id => this.has(key === 'runIds' ? 'runs' : 'supervision.signals',id))) return true;
    }
    return nested.some(key => row[key] && typeof row[key] === 'object' && this.reference(row[key]));
  }
  private mixedReview(row: Row) {
    if (!Array.isArray(row.runIds) || !Array.isArray(row.signalIds)) return;
    const runIds = row.runIds.filter(id => !this.has('runs',id));
    const signalIds = row.signalIds.filter(id => !this.has('supervision.signals',id));
    if ((runIds.length || signalIds.length) && (runIds.length !== row.runIds.length || signalIds.length !== row.signalIds.length))
      return {...row,runIds,signalIds,text:'原复核包含已移除项目，请按保留的执行和信号重新复核。'};
  }
  belongs(doc: StoredDocument): boolean {
    const {collection,id,value} = doc, row = object(value);
    if (connectorEvidence.has(collection) || collection === journal || collection === 'core.event-metadata' || collection === 'knowledge.curator') return false;
    // Explicit foreign ownership wins over a source/citation in another scope.
    const owner = row.projectId ?? object(row.scope).projectId;
    if (owner !== undefined && owner !== this.projectId) return false;
    if (row.layer === 'global' || row.layer === 'personal' || object(row.scope).kind === 'global') return false;
    if (collection === 'supervisor.reviews' && this.mixedReview(row)) return false;
    if ((collection === 'core.events' || collection === 'eventbox.events') && String(row.type).startsWith('supervisor.review') && this.mixedReview(object(row.data))) return false;
    if (this.has(collection,id) || this.has(keyed[collection],id)) return true;
    if (collection === 'policies') {
      try { const [project,run] = JSON.parse(id); return project === this.projectId || this.has('runs',run); } catch { return false; }
    }
    if (collection === 'dispatch-keys') return this.has('runs',value);
    if (collection === 'background.approval-requests' && this.has('approvals',row.id)) return true;
    if (collection === 'feishu.bot.dispatch' && (this.has('messages',row.id) || this.has('event.mailboxes',id.split(':').at(-1)))) return true;
    if (collection === 'feishu.bot.sends' || collection === 'effects') {
      if (id.startsWith('feishu-bot-send:')) {
        try {
          const [bot, ,key] = JSON.parse(id.slice('feishu-bot-send:'.length));
          if (this.has('mailbox-send-keys',JSON.stringify([bot,key]))) return true;
        } catch { /* Legacy or unrelated effect key. */ }
      }
    }
    if (collection === 'notifications.decision-sources') {
      if (id.startsWith('web-message:')) return this.has('messages',id.slice(12));
      const decision = /^decision:(approval|plan):(.+):[0-9]+$/.exec(id);
      if (decision) return this.has(kinds[decision[1]!],decision[2]);
    }
    if (collection === 'notifications.away' && id.startsWith('away:') && this.has('eventbox.events',id.slice(5))) return true;
    if (collection === 'outbox.items' && this.has('notifications.away',row.dedupKey)) return true;
    if (collection === 'outbox.items' && this.has('mixed-brief-outbox',id)) return false;
    if (collection === 'approvals' && this.has('mixed-brief-outbox',object(row.params).outboxId)) return true;
    if (collection === 'effects') {
      const sent = /^outbox:(.+):[0-9]+$/.exec(id);
      if (sent && this.has('outbox.items',sent[1])) return true;
    }
    if (collection === 'effects' && (this.typedKey(id.replace(/:start$/,'')) || this.has('runs',row.target) && String(row.kind).startsWith('executor.'))) return true;
    if (collection.startsWith('notifications.') && this.typedKey(id)) return true;
    if (collection === 'core.events' || collection === 'eventbox.events') {
      if (collection === 'eventbox.events' && this.has('eventbox.events',row.rootId)) return true;
      const type = String(row.type);
      const data = object(row.data);
      const target = eventCollections[type] ?? kinds[type.split('.')[0]!] ?? (type.startsWith('work.decision.') ? 'work.decisions' : type.split('.')[0]);
      if (this.has(target,data.id)) return true;
      if (type === 'inbox-handling.changed' && ['inbox-handling.requests','inbox-handling.suggestions'].some(c => this.has(c,data.id))) return true;
    }
    if (collection === 'plans' && Array.isArray(row.tasks) && row.tasks.length) return row.tasks.every(task => this.planTask(id,task));
    return this.reference(row);
  }
  remember(doc: StoredDocument) {
    const row = object(doc.value);
    let changed = this.add(doc.collection,doc.id);
    if (doc.collection === 'scheduled-work.requests' || doc.collection === 'scheduled-work.occurrences' || doc.collection === 'knowledge.sources') {
      if (typeof row.approvalId === 'string') changed = this.add('approvals',row.approvalId) || changed;
    }
    if (doc.collection === 'runs' && row.machineId && row.sessionId)
      changed = this.add('owned-node-sessions',JSON.stringify([row.machineId,row.sessionId])) || changed;
    if (doc.collection === 'event.mailboxes' && row.direction === 'outbox' && typeof row.botId === 'string' && typeof row.eventKey === 'string')
      changed = this.add('mailbox-send-keys',JSON.stringify([row.botId,row.eventKey])) || changed;
    if (doc.collection === 'background.review-cards' && typeof row.cardId === 'string') changed = this.add('interactions',row.cardId) || changed;
    if (typeof row.id === 'string' && ['eventbox.events','effects'].includes(doc.collection)) changed = this.add(doc.collection,row.id) || changed;
    if (doc.collection === 'inbox-handling.approvals' || doc.collection === 'knowledge.source-approvals') {
      const approval = doc.collection === 'inbox-handling.approvals' ? doc.id : row.approvalId;
      if (typeof approval === 'string') changed = this.add('approvals',approval) || changed;
    }
    return changed;
  }
  private planTask(planId:string, task:unknown) {
    const value = object(task);
    if (value.projectId || value.todoId || value.runId) return this.reference(value);
    return this.has('plan-origins',planId);
  }
  collect(rows: StoredDocument[]) {
    for (const doc of rows) {
      if (doc.collection !== 'background.briefs') continue;
      const cleaned = this.cleaned(doc);
      if (cleaned === doc.value) continue;
      const copies = rows.filter(item => item.collection === 'outbox.items' && object(item.value).owner === 'daily-brief' && object(item.value).causedBy === doc.id);
      const event = rows.find(item => item.collection === 'eventbox.events' && item.id === doc.id);
      const name = String(object(object(event?.value).data).name ?? '');
      for (const copy of copies) {
        const facts = object(cleaned).facts as Parameters<typeof formatWindowBrief>[0];
        this.briefCopies.set(copy.id,{oldHash:digest(object(copy.value).content),text:formatWindowBrief(facts,name)});
        this.add('mixed-brief-outbox',copy.id);
      }
    }
    let changed: boolean;
    do {
      changed = false;
      for (const doc of rows) if (this.belongs(doc)) changed = this.remember(doc) || changed;
    } while (changed);
    for (const doc of rows) if (doc.collection === 'supervisor.reviews' && this.mixedReview(object(doc.value))) {
      this.add('mixed-reviews',doc.id);
    }
    for (const doc of rows) if (doc.collection === 'eventbox.events') {
      const event = object(doc.value);
      if (event.type !== 'supervisor.review.created' || !this.mixedReview(object(event.data))) continue;
      for (const outgoing of rows) {
        const item = object(outgoing.value);
        if (outgoing.collection !== 'outbox.items' || item.owner !== 'supervisor' || item.causedBy !== doc.id) continue;
        this.briefCopies.set(outgoing.id,{oldHash:digest(item.content),text:'原复核包含已移除项目，请重新复核。'});
        this.add('mixed-brief-outbox',outgoing.id);
      }
    }
    for (const doc of rows) if (doc.collection === 'background.review-cards' && this.has('mixed-reviews',doc.id)) {
      const card = object(doc.value).cardId;
      if (typeof card === 'string') this.add('mixed-review-cards',card);
    }
  }
  // Shared views carry multiple projects. Retain unrelated elements and invalidate
  // old optimistic versions of mixed plans when removing a task.
  cleaned(doc: StoredDocument): unknown {
    const row = object(doc.value);
    if (doc.collection === 'outbox.items') {
      const copy = this.briefCopies.get(doc.id);
      if (copy && copy.oldHash === digest(row.content) && object(row.content).text !== copy.text) {
        const {approvalId: _approval, ...item} = row;
        const content = {...object(item.content),text:copy.text};
        const status = ['queued','held','needs_approval'].includes(String(row.status)) ? 'cancelled' : row.status;
        return {...item,content,contentHash:digest(content),status,version:Number(row.version)+1};
      }
    }
    if (doc.collection === 'supervisor.reviews') return this.mixedReview(row) ?? doc.value;
    if (['eventbox.events','core.events'].includes(doc.collection) && String(row.type).startsWith('supervisor.review')) {
      const data = this.mixedReview(object(row.data));
      if (data) return {...row,data};
    }
    if (doc.collection === 'interactions' && this.has('mixed-review-cards',doc.id)) {
      const body = '原复核包含已移除项目，请重新复核。';
      if (row.body !== body) return {...row,body,version:Number(row.version)+1};
    }
    if (doc.collection === 'knowledge.curator' && doc.id === 'bindings' && Array.isArray(doc.value)) {
      const bindings = doc.value.filter(binding => !this.reference(binding));
      if (bindings.length !== doc.value.length) return bindings;
    }
    if (doc.collection === 'plans' && Array.isArray(row.tasks)) {
      const tasks = row.tasks.filter(task => !this.planTask(doc.id,task));
      if (tasks.length !== row.tasks.length) return {...row,tasks,version:Number(row.version)+1};
    }
    if (doc.collection === 'background.briefs') {
      const facts = object(row.facts);
      if (Array.isArray(facts.projects)) {
        const projects = facts.projects.filter(p => object(p).projectId !== this.projectId);
        if (projects.length !== facts.projects.length) return {...row,facts:{...facts,projects}};
      }
    }
    return doc.value;
  }
}

// Built-in node executors persist a binding for every mode, including legacy
// launches without a mode. A cwd or a native CLI thread ID alone proves nothing.
function managedSessions(projectId: string, ownership: Ownership, runs: Run[], machines: MachineClient | undefined, saveJournal:()=>void) {
  const tasks = runs.filter(run => {
    if (!ownership.has('runs',run.id) || !run.machineId || !run.sessionId) return false;
    return ['codex','claude-code','pi'].some(id => run.executorId === id || run.executorId === run.machineId+'/'+id);
  });
  const receiptKey = (run: Run) => JSON.stringify([run.machineId,run.id,run.sessionId,run.status]);
  const remaining = tasks.filter(run => !ownership.has('confirmed-node-purges',receiptKey(run)));
  for (const task of remaining) {
    if (!['completed','failed','cancelled'].includes(task.status)) fail('项目仍有未确认结束的执行，请先核实执行状态',409);
    if (runs.some(run => run.id !== task.id && run.machineId === task.machineId && run.sessionId === task.sessionId))
      fail('托管会话对应多条执行记录，无法确认唯一归属',409);
    const node = machines?.list().find(machine => machine.id === task.machineId);
    if (!node?.online || !node.capabilities.includes('workspace.executor.purge')) fail('清理托管执行结果需要原执行机在线且支持项目清理',409);
  }
  return async () => {
    for (const task of remaining) {
      const params = {projectId,runId:task.id,sessionId:task.sessionId!,status:task.status};
      try {
        const reply = object(await machines!.call(task.machineId!,'workspace.executor.purge',params));
        if (reply.projectId !== projectId || reply.runId !== task.id || reply.sessionId !== task.sessionId || reply.purged !== true)
          fail('清理回执与执行记录不匹配',409);
        ownership.add('confirmed-node-purges',receiptKey(task));
        saveJournal();
      } catch (error) {
        fail('执行机未确认清理，可重试：'+(error instanceof Error ? error.message : String(error)),409);
      }
    }
  };
}

export function createProjectPurge(store: WorkbenchStore, currentInput?: () => unknown) {
  const pending = new Set<string>();
  const fences = new Map<string,Ownership>();
  for (const entry of store.list<{projectId:string;ids:[string,string[]][]}>(journal)) fences.set(entry.projectId,new Ownership(entry.projectId,entry.ids));
  store.guardWrites(doc => {
    for (const fence of fences.values()) {
      const row = object(doc.value);
      if (doc.collection === 'runs' && fence.has('owned-node-sessions',JSON.stringify([row.machineId,row.sessionId]))) fail('执行机会话正在清理或已移除',409);
      const actor = currentInput?.();
      if ((actor && (fence.reference(actor) || fence.has('messages',object(actor).id))) || fence.has(doc.collection,doc.id) || fence.belongs(doc) || fence.cleaned(doc) !== doc.value) {
        // Knowledge backends reconcile unchanged index entries during reads.
        if (doc.collection === 'knowledge' && JSON.stringify(store.get(doc.collection,doc.id)) === JSON.stringify(doc.value)) continue;
        fail('项目已移除或正在清理，拒绝迟到写入',409);
      }
    }
  });
  async function purge(id: string, input: Record<string,unknown>, hooks: {
    machines?: MachineClient;
    check(todoIds:string[]):void;
    checkRuns?(runIds:string[]):void;
    lock<T>(action:(removeHistory:()=>void)=>Promise<T>):Promise<T>;
    cleanKnowledge():Promise<unknown>;
    stop(runIds:string[]):void;
  }) {
    function check() {
      const project = store.get<Project>('projects',id);
      if (!project) return fail('项目不存在',404);
      if (!input || Object.keys(input).length !== 1 || input.confirmName !== project.name) fail('请准确输入项目名称以确认彻底移除',400);
      hooks.check(store.list<{id:string;projectId?:string}>('todos').filter(t => t.projectId === id).map(t => t.id));
    }
    check();
    if (pending.has(id)) fail('项目清理正在进行',409);
    pending.add(id);
    try {
      return await hooks.lock(async removeHistory => {
        check();
        const fence = fences.get(id) ?? new Ownership(id);
        fence.collect(store.documents());
        const runs = store.list<Run>('runs');
        const runIds = runs.filter(run => fence.has('runs',run.id)).map(run => run.id);
        hooks.checkRuns?.(runIds);
        const saveJournal = () => store.put(journal,id,{projectId:id,ids:fence.save()});
        const cleanSessions = managedSessions(id,fence,runs,hooks.machines,saveJournal);
        saveJournal();
        fences.set(id,fence);
        hooks.stop(runIds);
        await cleanSessions();
        await hooks.cleanKnowledge();
        return store.transaction(() => {
          check();
          const rows = store.documents();
          fence.collect(rows);
          removeHistory();
          for (const doc of rows) {
            if (fence.belongs(doc)) store.remove(doc.collection,doc.id);
            else {
              const cleaned = fence.cleaned(doc);
              if (cleaned !== doc.value) store.put(doc.collection,doc.id,cleaned);
            }
          }
          store.remove('knowledge.curator','purge-workers:'+id);
          store.remove(journal,id);
          return {purged:true};
        });
      });
    } finally { pending.delete(id); }
  };
  return { purge, fenced: (id: string) => fences.has(id) };
}
