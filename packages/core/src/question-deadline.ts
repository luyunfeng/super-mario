import type { QuestionItem } from '../../protocol/src/index.ts';
import type { Card } from './interactions.ts';

function invalid(message:string):never { throw Object.assign(new Error(message),{status:400}); }
const units:Record<string,number> = {h:3600000,m:60000,s:1000,ms:1,us:0.001,'µs':0.001,'μs':0.001,ns:0.000001};
function deadlineTime(value:string, now:number) {
  if (/^\d{4}-\d{2}-\d{2}T\d\d:\d\d:\d\d(?:\.\d+)?(?:Z|[+-]\d\d:\d\d)$/i.test(value)) {
    const date=value.slice(0,10);
    const day=new Date(date+'T00:00:00Z');
    if (Number(value.slice(11,13))>=24 || !Number.isFinite(day.getTime()) || day.toISOString().slice(0,10)!==date) return NaN;
    return Date.parse(value);
  }
  const input=value.replace(/^\+/,'');
  const part=/(\d+(?:\.\d*)?|\.\d+)(ns|[uµμ]s|ms|s|m|h)/gy;
  let duration=0, pos=0;
  while (pos<input.length) {
    const match=part.exec(input);
    if (!match) return NaN;
    duration+=Number(match[1])*units[match[2]!]!;
    pos=part.lastIndex;
  }
  return now+duration;
}

export function questionDeadline(input:{kind:string;runId?:string;questions?:QuestionItem[];deadline?:string;reversible?:boolean},now:number) {
  if (input.deadline===undefined && input.reversible===undefined) return {};
  if (input.kind!=='question' || input.runId || !input.questions?.length) invalid('只有对话中的结构化普通问题支持截止设置');
  if (input.reversible!==undefined && typeof input.reversible!=='boolean') invalid('reversible 须为布尔值');
  if (input.deadline===undefined || (typeof input.deadline==='string' && !input.deadline.trim())) return input.reversible===undefined ? {} : {reversible:input.reversible};
  if (typeof input.deadline!=='string' || input.deadline.length>128) invalid('deadline 须为带时区的截止时间或时长');
  if (input.reversible===undefined || !input.questions.every(q=>q.recommend && q.options.some(o=>o.label===q.recommend)))
    invalid('设置截止须明确是否可逆，并为每题推荐一个已有选项');
  const at=deadlineTime(input.deadline.trim(),now);
  if (!Number.isFinite(at) || at-now<60000 || at-now>30*86400000) invalid('截止时间须在 1 分钟至 30 天之间');
  return {decisionDeadlineAt:new Date(at).toISOString(),reversible:input.reversible};
}

export function cardAcceptsAnswer(card:Pick<Card,'status'|'expiresAt'|'decisionDeadlineAt'|'reversible'|'deadlineRemindedAt'>,now=Date.now()) {
  if (card.status!=='open') return false;
  if (card.decisionDeadlineAt) return Date.parse(card.decisionDeadlineAt)>now || card.reversible===false || !!card.deadlineRemindedAt;
  return Date.parse(card.expiresAt)>now;
}
