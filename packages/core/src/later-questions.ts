import { randomUUID } from 'node:crypto';
import type { Store } from '../../plugin-sdk/src/index.ts';
import type { Message } from '../../protocol/src/index.ts';
import type { Card } from './interactions.ts';
import { cardAcceptsAnswer } from './question-deadline.ts';
import { questionEvidence } from './question-responses.ts';

interface Later {
  id: string; inputId: string; audience: string; requestId: string;
  spokeAt?: string; text?: string; defaultResult?: true;
}
export interface QuestionHost {
  source(card: Card): { input: Message; audience: string } | undefined;
  post(source: Message, text: string, key: string, readOnly: boolean, accepted: (message: Message) => void): Promise<Message>;
}
const collection = 'interaction.later-questions';
const keep = 24 * 3600_000;
function conflict(message: string): never { throw Object.assign(new Error(message), { status: 409 }); }

export function createLaterQuestions(store: Store, host: QuestionHost, materialize: (card: Card) => string | undefined, changed: (id:string)=>void) {
  const jobs = new Map<string, Promise<void>>();
  function end(id: string): Promise<void> {
    const existing = jobs.get(id);
    if (existing) return existing;
    const job = Promise.resolve().then(async () => {
      const card = store.get<Card>('interactions', id);
      if (!card || (card.wait !== false && !card.byDefault) || card.status === 'open') return;
      let row = store.get<Later>(collection, id);
      if (!row && card.byDefault) {
        // A blocking card joins this durable queue only if its deadline supplies the result.
        // Freeze the audience at creation and never infer one from a later pairing.
        const origin = store.get<{inputId:string;deadlineAudience?:string;continuationId?:string}>('interaction-origins',id);
        if (origin?.continuationId) return;
        if (!origin?.deadlineAudience || !origin.inputId) conflict('缺少截止提问的原会话凭据');
        row = {id,inputId:origin.inputId,audience:origin.deadlineAudience,requestId:randomUUID(),defaultResult:true};
        store.put(collection,id,row);
      }
      if (!row) return;
      try {
        const source = host.source(card);
        if (!source || source.input.id !== row.inputId || source.audience !== row.audience) conflict('原提问会话或配对已变化');
        const answered = card.status === 'answered';
        const text = row.text ?? store.transaction(() => {
          const todoId = card.status === 'expired' && !row.spokeAt ? materialize(card) : undefined;
          let notice: string;
          if (card.byDefault) notice = '提问到期，系统已采用可撤销的推荐选项，主人未作答。请按原目标和推荐选择在本对话内继续，例如按所选顺序给出草稿。此默认结果仅供只读处理，不授权外发、派工或修改数据。';
          else if (answered) notice = '主人已回答稍后处理的提问。请在原目标范围内处理回答。';
          else if (card.status === 'withdrawn') notice = '稍后处理的提问已撤回，未提供答案。';
          else if (row.spokeAt) notice = '提问已过期。主人期间在原对话发过消息，本卡未收到答复，本次没有创建待办。';
          else if (todoId) notice = '提问已过期，尚未收到答复。已转为待办，主人可稍后回答。';
          else conflict('过期提问的待办尚未登记');
          const text = notice + '\n' + JSON.stringify({卡片:id,提问时间:card.createdAt,标题:card.title,问题说明:card.body,
            ...(card.questions && {题目:card.questions.map(question=>question.question)}), ...(todoId && {待办:todoId}),
            ...(answered && (card.byDefault ? {系统默认选择:card.answer} : {主人回答:card.answer})),
            ...(answered && card.questions && card.answers && {逐题回答:questionEvidence(card.questions,card.answers)})});
          store.put(collection,id,{...row,text});
          return text;
        });
        await host.post(source.input, text, row.requestId, !answered || card.byDefault === true, message => {
          // The original route, acceptance receipt and terminal acknowledgement commit together.
          store.remove(collection,id);
          const origin=store.get<{inputId:string}>('interaction-origins',id);
          store.put('interaction-origins',id,{...origin,continuationId:message.id});
          if (answered) {
            const current=store.get<Card>('interactions',id)!;
            if (current.delivery !== 'confirmed') {
              const {error, ...facts}=current;
              store.put('interactions',id,{...facts,version:current.version+1,delivery:'confirmed',updatedAt:message.createdAt});
              changed(id);
            }
          }
        });
      } catch (error) {
        // A caller can lose its return value after SQLite accepted the input.
        // The callback's committed receipt wins over that transport error.
        const receipt = store.get<{continuationId?:string}>('interaction-origins',id)?.continuationId;
        const accepted = receipt && store.get<Message>('messages',receipt);
        if (accepted && accepted.requestId === row.requestId && !store.get(collection,id)) return;
        if (Date.now() > Date.parse(card.expiresAt) + keep) store.remove(collection,id);
        throw error;
      }
    });
    jobs.set(id,job);
    void job.then(()=>jobs.delete(id),()=>jobs.delete(id));
    return job;
  }
  const hasCapacity = () => store.list<Later>(collection).filter(row=>!row.defaultResult).length < 20;
  return {
    hasCapacity,
    hasSpoken(id:string) { return !!store.get<Later>(collection,id)?.spokeAt; },
    assertCapacity() {
      if (!hasCapacity()) conflict('最多同时保留 20 张稍后回答的问题卡');
    },
    register(card: Card, inputId: string, audience: string) {
      store.put(collection,card.id,{id:card.id,inputId,audience,requestId:randomUUID()} satisfies Later);
    },
    spoke(message: Message, audience: string) {
      for (const row of store.list<Later>(collection)) {
        if (row.audience !== audience || row.inputId === message.id || row.spokeAt) continue;
        const card=store.get<Card>('interactions',row.id);
        if (card?.status === 'open' && cardAcceptsAnswer(card)) store.put(collection,row.id,{...row,spokeAt:message.createdAt});
      }
    },
    end,
    recover() {
      for (const row of store.list<Later>(collection)) {
        if (store.get<Card>('interactions',row.id)?.status !== 'open') void end(row.id).catch(()=>{});
      }
    },
    async drain() { await Promise.allSettled([...jobs.values()]); },
  };
}
