import { randomUUID } from 'node:crypto';
import type { Store } from '../../plugin-sdk/src/index.ts';
import type { Message, Todo } from '../../protocol/src/index.ts';
import type { Card } from './interactions.ts';

interface Row {
  cardId: string; todoId: string; inputId: string; audience: string; requestId: string;
  action?: { kind: 'answer'; text: string } | { kind: 'closed' };
  messageId?: string;
}
type Action = NonNullable<Row['action']>;
const collection = 'interaction.deferred-questions';
function fail(message: string, status = 409): never { throw Object.assign(new Error(message), {status}); }

export function createDeferredQuestions(store: Store, host: {
  source(card: Card): {input:Message; audience:string} | undefined;
  create(card: Card, source: Message): Todo;
  post(source: Message, text: string, key: string, closed: boolean, accepted: (message:Message)=>void): Promise<Message>;
  complete(id: string): void;
  changed(id: string): void;
}) {
  function materialize(card: Card) {
    if (card.kind !== 'question' || card.runId || card.status !== 'expired') return;
    const existing=store.get<Row>(collection,card.id);
    if (existing) {
      const todo=store.get<Todo>('todos',existing.todoId);
      const link=todo?.deferredQuestion;
      if (todo && link && link.cardId===card.id && link.askedAt===card.createdAt && todo.projectId===card.projectId &&
          (link.title===undefined || link.body===undefined) && host.source(card)?.audience===existing.audience) {
        store.put('todos',todo.id,{...todo,deferredQuestion:{...link,title:card.title,body:card.body}});
        host.changed(todo.id);
      }
      return;
    }
    const source = host.source(card);
    if (!source) return;
    store.transaction(()=>{
      if (store.get(collection,card.id)) return;
      const todo = host.create(card,source.input);
      store.put(collection,card.id,{cardId:card.id,todoId:todo.id,inputId:source.input.id,audience:source.audience,requestId:randomUUID()} satisfies Row);
      host.changed(todo.id);
    });
  }
  const jobs = new Map<string,Promise<string>>();
  function validate(row:Row) {
    const todo = store.get<Todo>('todos',row.todoId);
    const card = store.get<Card>('interactions',row.cardId);
    if (!todo || todo.deferredQuestion?.cardId !== row.cardId || !card || card.status !== 'expired' ||
        todo.projectId !== card.projectId || card.createdAt !== todo.deferredQuestion.askedAt) fail('原提问待办或所属项目已变化');
    const source=host.source(card);
    if (!source || source.input.id!==row.inputId || source.audience!==row.audience) fail('原提问会话或配对已失效');
    return {todo,card,source};
  }
  function deliver(cardId:string) {
    const active=jobs.get(cardId);
    if (active) return active;
    const job=Promise.resolve().then(async()=>{
      const row=store.get<Row>(collection,cardId);
      if (!row?.action) fail('提问待办的处理请求已失效');
      if (row.messageId) return row.messageId;
      const {card,source,todo}=validate(row);
      const answered=row.action.kind==='answer';
      if (answered && todo.completedAt) fail('提问待办已关闭');
      const intro=answered ? '主人已回答此前过期的提问。请按原问题继续，回答仅适用于这个问题。' :
        '此前的提问待办已关闭，未提供答案。请停止等待。关闭不授权执行原提问中的操作。';
      const text=intro+'\n'+JSON.stringify({待办:todo.id,提问时间:card.createdAt,原目标:source.input.text,问题:card.title,问题说明:card.body,
        ...(row.action.kind==='answer' && {主人回答:row.action.text})});
      const result=await host.post(source.input,text,row.requestId,!answered,message=>{
        // This callback runs inside the acceptance transaction, before any model work.
        validate(row);
        store.put(collection,row.cardId,{...row,messageId:message.id});
        if (answered) host.complete(row.todoId);
      });
      return result.id;
    });
    jobs.set(cardId,job);
    void job.then(()=>jobs.delete(cardId),()=>jobs.delete(cardId));
    return job;
  }
  function prepare(todo:Todo, action:Action) {
    const id=todo.deferredQuestion?.cardId;
    const row=id && store.get<Row>(collection,id);
    if (!row || row.todoId!==todo.id) fail('这项待办没有可回答的原提问',404);
    validate(row);
    if (row.action) {
      if (action.kind !== row.action.kind || (action.kind==='answer' && row.action.kind==='answer' && action.text!==row.action.text)) fail('原提问已经处理或正在回投其他答复');
      return row;
    }
    if (action.kind==='answer' && todo.completedAt) fail('提问待办已关闭');
    const next={...row,action};
    store.put(collection,id,next);
    return next;
  }
  return {
    materialize,
    async answer(todoId:string, input:unknown) {
      if (typeof input!=='string' || !input.trim() || Array.from(input.trim()).length>4000) fail('回答须为 1 到 4000 字的文本',400);
      const todo=store.get<Todo>('todos',todoId) ?? fail('待办不存在',404);
      const row=prepare(todo,{kind:'answer',text:input.trim()});
      const messageId = row.messageId ?? await deliver(row.cardId);
      const confirmed = store.get<Row>(collection,row.cardId);
      if (confirmed?.messageId !== messageId || confirmed.action?.kind !== 'answer' || confirmed.action.text !== input.trim())
        fail('该待办已关闭，原问题未收到本次答案');
      return {todoId,messageId};
    },
    ownerDecision(todoId:string,text:string) {
      const todo=store.get<Todo>('todos',todoId);
      if (!todo?.deferredQuestion || todo.completedAt) return;
      const row=prepare(todo,{kind:'answer',text});
      void deliver(row.cardId).catch(()=>{ /* The original accepted decision stays pending for recovery. */ });
    },
    closed(todo:Todo) {
      if (!todo.deferredQuestion) return;
      const row=store.get<Row>(collection,todo.deferredQuestion.cardId);
      if (!row || row.todoId!==todo.id || row.messageId) return;
      // An explicit close before a queued answer's acceptance takes precedence.
      store.put(collection,row.cardId,{...row,action:{kind:'closed'}});
      void deliver(row.cardId).catch(()=>{});
    },
    recover() {
      for (const row of store.list<Row>(collection)) if (row.action && !row.messageId) void deliver(row.cardId).catch(()=>{});
    },
    async drain() { await Promise.allSettled([...jobs.values()]); },
  };
}
